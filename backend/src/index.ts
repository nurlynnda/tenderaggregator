import { MyProcurementAdapter } from './scrapers/myprocurement/adapter.js';
import { createPoliteFetcher } from './http/politeFetch.js';
import { TenderRepository } from './storage/repository.js';
import { ScrapeManager } from './scrape/manager.js';
import { createApp } from './api/app.js';

const PORT = Number(process.env.PORT) || 3001;
const DATA_DIR = process.env.DATA_DIR || new URL('../data', import.meta.url).pathname;

async function main() {
  const repo = new TenderRepository(DATA_DIR);
  await repo.load();

  const adapters = [new MyProcurementAdapter(createPoliteFetcher())];
  const manager = new ScrapeManager(adapters, repo);

  // Startup scrape policy (spec: Startup section):
  // - no data at all           -> full scrape (open + archive backfill)
  // - data but backfill unset  -> resume archive backfill only
  // - otherwise                -> nothing
  const needsFull = adapters.every((a) => !repo.hasSource(a.name));
  const needsBackfill = adapters.some((a) => repo.getMeta(a.name).lastArchiveBackfillAt === null);
  if (needsFull) {
    console.log('[startup] no data found — starting full scrape (open + archive backfill)');
    manager.start('all');
  } else if (needsBackfill) {
    console.log('[startup] archive backfill incomplete — resuming');
    manager.start('archive');
  }

  createApp({ repo, manager }).listen(PORT, () => {
    console.log(`backend listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
