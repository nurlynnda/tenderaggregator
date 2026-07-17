import { MongoClient } from 'mongodb';
import { MyProcurementAdapter } from './scrapers/myprocurement/adapter.js';
import { SpanAdapter } from './scrapers/span/adapter.js';
import { KwspAdapter } from './scrapers/kwsp/adapter.js';
import { LlmAdapter } from './scrapers/llm/adapter.js';
import { createSpanFetchImpl } from './scrapers/span/spanFetchImpl.js';
import { createKwspBrowserFetchImpl } from './scrapers/kwsp/kwspBrowserFetchImpl.js';
import { createPoliteFetcher } from './http/politeFetch.js';
import { TenderRepository } from './storage/repository.js';
import type { SourceMetaDoc } from './storage/repository.js';
import type { TenderDoc } from './storage/tenderDoc.js';
import { ScrapeManager } from './scrape/manager.js';
import { createApp } from './api/app.js';
import { decideStartupPolicy } from './startupPolicy.js';
import { DailyScheduler } from './scheduler/DailyScheduler.js';
import { createDailyRunStateStore } from './scheduler/dailyRunState.js';
import type { SchedulerStateDoc } from './scheduler/dailyRunState.js';
import { PendingRegistrationRepository } from './auth/pendingRegistrationRepository.js';
import { UserRepository } from './auth/userRepository.js';
import { SessionRepository } from './auth/sessionRepository.js';
import { MailgunEmailSender } from './auth/emailSender.js';
import { SimpleWebAuthnService } from './auth/webauthnService.js';
import { InMemoryRateLimiter } from './auth/rateLimiter.js';
import type { PendingRegistrationDoc, SessionDoc, UserDoc } from './auth/types.js';

const PORT = Number(process.env.PORT) || 3001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/tms';
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY ?? '';
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN ?? '';
const MAILGUN_FROM_EMAIL = process.env.MAILGUN_FROM_EMAIL ?? '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? '';
const SESSION_SECRET = process.env.SESSION_SECRET ?? '';
const RP_ID = process.env.RP_ID ?? 'localhost';
const RP_NAME = process.env.RP_NAME ?? 'Malaysia Tender Aggregator';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5173';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

if (!ADMIN_EMAIL || !SESSION_SECRET || !MAILGUN_API_KEY || !MAILGUN_DOMAIN || !MAILGUN_FROM_EMAIL) {
  throw new Error('ADMIN_EMAIL, SESSION_SECRET, MAILGUN_API_KEY, MAILGUN_DOMAIN, and MAILGUN_FROM_EMAIL must be set');
}

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();
  const tendersCollection = db.collection<TenderDoc>('tenders');
  const sourceMetaCollection = db.collection<SourceMetaDoc>('sourceMeta');
  const schedulerStateCollection = db.collection<SchedulerStateDoc>('schedulerState');

  // Idempotent: createIndex on an already-existing equivalent index is a no-op, so this is
  // safe to run on every startup rather than only once. Supports the filters/sort in
  // query/tenders.ts (buildMatchStage + the $sort stage in queryTenders) and buildFacets'
  // distinct() calls.
  await Promise.all([
    tendersCollection.createIndex({ status: 1 }),
    tendersCollection.createIndex({ ministry: 1 }),
    tendersCollection.createIndex({ agency: 1 }),
    tendersCollection.createIndex({ category: 1 }),
    tendersCollection.createIndex({ closingDate: 1 }),
    tendersCollection.createIndex({ advertisedDate: 1 }),
    tendersCollection.createIndex({ 'sources.source': 1 }),
  ]);

  const pendingRegistrationsCollection = db.collection<PendingRegistrationDoc>('pendingRegistrations');
  const usersCollection = db.collection<UserDoc>('users');
  const sessionsCollection = db.collection<SessionDoc>('sessions');

  await Promise.all([
    pendingRegistrationsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    usersCollection.createIndex({ email: 1 }, { unique: true }),
    sessionsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);

  const pendingRegistrations = new PendingRegistrationRepository(pendingRegistrationsCollection);
  const users = new UserRepository(usersCollection);
  const sessions = new SessionRepository(sessionsCollection);
  const email = new MailgunEmailSender(MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM_EMAIL);
  const webauthn = new SimpleWebAuthnService(RP_ID, RP_NAME, ORIGIN);
  const rateLimiter = new InMemoryRateLimiter();

  const repo = new TenderRepository(tendersCollection, sourceMetaCollection);

  // Self-heals tenders left stuck as "open" past their deadline (see
  // docs/superpowers/specs/2026-07-10-stale-open-status-reconciliation-design.md) — fixes
  // whatever accumulated since this last ran; the daily scheduler below (see end of main())
  // keeps catching up even if nobody restarts the server or triggers a rescrape.
  const startupStaleCount = await repo.reconcileStaleOpen();
  if (startupStaleCount > 0) {
    console.log(`[startup] reconciled ${startupStaleCount} stale open tender(s)`);
  }

  const adapters = [
    new MyProcurementAdapter(createPoliteFetcher()),
    new SpanAdapter(createPoliteFetcher({ responseType: 'text', fetchImpl: createSpanFetchImpl() })),
    new KwspAdapter(createKwspBrowserFetchImpl()),
    new LlmAdapter(createPoliteFetcher({ responseType: 'text' })),
  ];
  const manager = new ScrapeManager(adapters, repo);

  // Startup scrape policy, decided PER ADAPTER (see startupPolicy.ts and
  // docs/superpowers/specs/2026-07-10-scrape-settings-page-design.md): a brand-new adapter
  // always gets its own full scrape at startup, regardless of whether other adapters already
  // have data.
  const mergedIsEmpty = (await repo.count()) === 0;
  const plan: Array<{ name: string; scope: 'all' | 'archive' }> = [];
  for (const adapter of adapters) {
    const hasSource = await repo.hasSource(adapter.name);
    const { completedArchiveJobs } = await repo.getMeta(adapter.name);
    const { needsFull, needsBackfill, emptyStoreMismatch } = decideStartupPolicy({
      hasSource,
      mergedIsEmpty,
      archiveJobNames: adapter.archiveJobNames(),
      completedArchiveJobs,
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

  const dailyRunState = createDailyRunStateStore(schedulerStateCollection);
  const dailyScheduler = new DailyScheduler({
    run: async () => {
      const staleCount = await repo.reconcileStaleOpen();
      if (staleCount > 0) console.log(`[daily] reconciled ${staleCount} stale open tender(s)`);
      await manager.waitUntilIdle();
      if (!manager.start('open', { sourceName: 'myprocurement' })) {
        console.log("[daily] scrape already in progress after waiting — skipping today's auto-scrape");
      }
    },
    loadLastRunDate: () => dailyRunState.load(),
    saveLastRunDate: (date) => dailyRunState.save(date),
  });
  try {
    await dailyScheduler.start();
  } catch (err) {
    console.error('[daily] scheduler failed to start; continuing without it:', err);
  }

  createApp({
    repo, tendersCollection, manager,
    pendingRegistrations, users, sessions, email, webauthn, rateLimiter,
    adminEmail: ADMIN_EMAIL,
    sessionTtlMs: SESSION_TTL_MS,
    cookieSecret: SESSION_SECRET,
  }).listen(PORT, () => {
    console.log(`backend listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
