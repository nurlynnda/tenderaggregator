import { MyProcurementAdapter } from './scrapers/myprocurement/adapter.js';
import { SpanAdapter } from './scrapers/span/adapter.js';
import { KwspAdapter } from './scrapers/kwsp/adapter.js';
import { createSpanFetchImpl } from './scrapers/span/spanFetchImpl.js';
import { createKwspBrowserFetchImpl } from './scrapers/kwsp/kwspBrowserFetchImpl.js';
import { createPoliteFetcher } from './http/politeFetch.js';
import { TenderRepository } from './storage/repository.js';
import { ScrapeManager } from './scrape/manager.js';
import { createApp } from './api/app.js';
import { decideStartupPolicy } from './startupPolicy.js';
import { resolveDataDir } from './resolveDataDir.js';
import { DailyScheduler } from './scheduler/DailyScheduler.js';
import { createDailyRunStateStore } from './scheduler/dailyRunState.js';

const PORT = Number(process.env.PORT) || 3001;
const DATA_DIR = resolveDataDir(import.meta.url, process.env.DATA_DIR);

async function main() {
  const repo = new TenderRepository(DATA_DIR);
  await repo.load();

  // Self-heals tenders left stuck as "open" past their deadline (see
  // docs/superpowers/specs/2026-07-10-stale-open-status-reconciliation-design.md) — fixes
  // whatever accumulated since this last ran; the daily scheduler below (see end of main())
  // keeps catching up even if nobody restarts the server or triggers a rescrape.
  const startupStaleCount = repo.reconcileStaleOpen();
  if (startupStaleCount > 0) {
    console.log(`[startup] reconciled ${startupStaleCount} stale open tender(s)`);
    await repo.flush();
  }

  const adapters = [
    new MyProcurementAdapter(createPoliteFetcher()),
    new SpanAdapter(createPoliteFetcher({ responseType: 'text', fetchImpl: createSpanFetchImpl() })),
    new KwspAdapter(createKwspBrowserFetchImpl()),
  ];
  const manager = new ScrapeManager(adapters, repo);

  // Startup scrape policy, decided PER ADAPTER (see startupPolicy.ts and
  // docs/superpowers/specs/2026-07-10-scrape-settings-page-design.md): a brand-new adapter
  // always gets its own full scrape, regardless of whether other adapters already have data.
  const mergedIsEmpty = repo.getAll().length === 0;
  const plan: Array<{ name: string; scope: 'all' | 'archive' }> = [];
  for (const adapter of adapters) {
    const { needsFull, needsBackfill, emptyStoreMismatch } = decideStartupPolicy({
      hasSource: repo.hasSource(adapter.name),
      mergedIsEmpty,
      archiveJobNames: adapter.archiveJobNames(),
      completedArchiveJobs: repo.getMeta(adapter.name).completedArchiveJobs,
    });
    if (emptyStoreMismatch) {
      console.warn(
        `[startup] ${adapter.name}: merged tender store is empty but this source reports prior completion — forcing full rescrape`,
      );
    }
    if (needsFull) plan.push({ name: adapter.name, scope: 'all' });
    else if (needsBackfill) plan.push({ name: adapter.name, scope: 'archive' });
  }
  if (plan.length > 0) {
    void (async () => {
      for (const { name, scope } of plan) {
        console.log(`[startup] ${name}: running ${scope} scrape`);
        await manager.runToCompletion(scope, { sourceName: name });
      }
    })();
  }

  const dailyRunState = createDailyRunStateStore(DATA_DIR);
  const dailyScheduler = new DailyScheduler({
    run: async () => {
      const staleCount = repo.reconcileStaleOpen();
      if (staleCount > 0) {
        console.log(`[daily] reconciled ${staleCount} stale open tender(s)`);
        await repo.flush();
      }
      await manager.waitUntilIdle();
      if (!manager.start('open', { sourceName: 'myprocurement' })) {
        console.log("[daily] scrape already in progress after waiting — skipping today's auto-scrape");
      }
    },
    loadLastRunDate: () => dailyRunState.load(),
    saveLastRunDate: (date) => dailyRunState.save(date),
  });
  await dailyScheduler.start();

  createApp({ repo, manager }).listen(PORT, () => {
    console.log(`backend listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
