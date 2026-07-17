import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TenderPatch } from '@tms/shared';
import { createApp } from '../src/api/app.js';
import { ScrapeManager } from '../src/scrape/manager.js';
import type { ScrapeHooks } from '../src/scrapers/types.js';
import { TenderRepository } from '../src/storage/repository.js';
import type { SourceMetaDoc } from '../src/storage/repository.js';
import type { TenderDoc } from '../src/storage/tenderDoc.js';
import { FakeCollection } from './support/fakeMongoCollection.js';
import { PendingRegistrationRepository } from '../src/auth/pendingRegistrationRepository.js';
import { UserRepository } from '../src/auth/userRepository.js';
import { SessionRepository } from '../src/auth/sessionRepository.js';
import { FakeEmailSender } from '../src/auth/emailSender.js';
import { FakeWebAuthnService } from '../src/auth/webauthnService.js';
import { InMemoryRateLimiter } from '../src/auth/rateLimiter.js';
import type { PendingRegistrationDoc, SessionDoc, UserDoc } from '../src/auth/types.js';

let seq = 0;
function patch(overrides: Partial<TenderPatch> = {}): TenderPatch {
  seq += 1;
  return {
    dedupKey: `REF/${seq}`, referenceNo: `REF/${seq}`, title: `TENDER ${seq}`,
    status: 'open', procurementType: 'quotation',
    scrapedAt: '2026-07-07T00:00:00.000Z',
    source: { source: 'myprocurement', sourceId: String(seq), sourceUrl: `https://example.com/${seq}` },
    ministry: 'KEMENTERIAN A', agency: null, category: null, fieldCodes: [],
    advertisedDate: '2026-07-01', closingDate: null, indicativePrice: null,
    ...overrides,
  };
}

async function waitUntilNotRunning(agent: ReturnType<typeof request.agent>): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const res = await agent.get('/api/scrape/status');
    if (res.body.state !== 'running') return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitUntilNotRunning: timed out');
}

describe('API', () => {
  let tendersCollection: FakeCollection<TenderDoc>;
  let repo: TenderRepository;
  let manager: ScrapeManager;
  let app: ReturnType<typeof createApp>;
  let sessions: SessionRepository;
  let users: UserRepository;

  function authDeps() {
    return {
      pendingRegistrations: new PendingRegistrationRepository(new FakeCollection<PendingRegistrationDoc>()),
      users,
      sessions,
      email: new FakeEmailSender(),
      webauthn: new FakeWebAuthnService(),
      rateLimiter: new InMemoryRateLimiter(),
      adminEmail: 'admin@example.com',
      sessionTtlMs: 1000 * 60 * 60,
      cookieSecret: 'test-secret',
    };
  }

  beforeEach(() => {
    tendersCollection = new FakeCollection<TenderDoc>();
    repo = new TenderRepository(tendersCollection, new FakeCollection<SourceMetaDoc>());
    manager = new ScrapeManager([], repo);
    sessions = new SessionRepository(new FakeCollection<SessionDoc>());
    users = new UserRepository(new FakeCollection<UserDoc>());
    app = createApp({ repo, tendersCollection, manager, ...authDeps() });
  });

  async function loginAsAgent(role: 'admin' | 'member', targetApp: ReturnType<typeof createApp> = app) {
    const user = await users.create({
      name: role, email: `${role}@example.com`, role,
      credential: { id: `${role}-cred`, publicKey: 'pk', counter: 0 },
    });
    const agent = request.agent(targetApp);
    await agent.post('/api/auth/login/options').send({ email: user.email });
    await agent.post('/api/auth/login/verify').send({ email: user.email, response: {} });
    return agent;
  }

  it('rejects unauthenticated requests to a protected route', async () => {
    const res = await request(app).get('/api/tenders');
    expect(res.status).toBe(401);
  });

  it('allows an authenticated member to read tenders but not trigger a rescrape', async () => {
    const agent = await loginAsAgent('member');
    expect((await agent.get('/api/tenders')).status).toBe(200);
    expect((await agent.post('/api/scrape').send({})).status).toBe(403);
  });

  it('allows an authenticated admin to trigger a rescrape', async () => {
    const agent = await loginAsAgent('admin');
    const res = await agent.post('/api/scrape').send({});
    expect(res.status).toBe(202);
  });

  it('GET /api/health stays open with no auth', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api/tenders returns paginated, filterable results', async () => {
    await repo.mergeMany([patch({ title: 'BUMBUNG GELANGGANG' }), patch({ status: 'closed' }), patch()]);
    const agent = await loginAsAgent('member');
    const all = await agent.get('/api/tenders');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.page).toBe(1);

    const filtered = await agent.get('/api/tenders?status=closed');
    expect(filtered.body.total).toBe(1);

    const searched = await agent.get('/api/tenders?search=bumbung');
    expect(searched.body.total).toBe(1);
  });

  it('GET /api/tenders supports fieldCode and hasWinners filters', async () => {
    await repo.mergeMany([
      patch({ fieldCodes: ['220801'] }),
      patch({ winners: [{ name: 'X', price: 1 }] }),
      patch(),
    ]);
    const agent = await loginAsAgent('member');
    const byField = await agent.get('/api/tenders?fieldCode=22');
    expect(byField.body.total).toBe(1);
    const awarded = await agent.get('/api/tenders?hasWinners=true');
    expect(awarded.body.total).toBe(1);
  });

  it('GET /api/tenders supports a contractor filter matching any winner name', async () => {
    await repo.mergeMany([
      patch({ winners: [{ name: 'SAFWORKS SDN. BHD.', price: 1 }] }),
      patch({ winners: [{ name: 'SUCEME ENTERPRISE', price: 2 }] }),
      patch(),
    ]);
    const agent = await loginAsAgent('member');
    const res = await agent.get('/api/tenders?contractor=SAFWORKS SDN. BHD.');
    expect(res.body.total).toBe(1);
  });

  it('GET /api/tenders supports closingFrom and closingTo as an inclusive date range', async () => {
    await repo.mergeMany([
      patch({ closingDate: '2026-07-05' }),
      patch({ closingDate: '2026-07-15' }),
      patch({ closingDate: '2026-07-25' }),
    ]);
    const agent = await loginAsAgent('member');
    const res = await agent.get('/api/tenders?closingFrom=2026-07-10&closingTo=2026-07-20');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it('GET /api/tenders?hasWinners=false returns unfiltered results, not awarded-only', async () => {
    await repo.mergeMany([patch({ winners: [{ name: 'X', price: 1 }] }), patch(), patch()]);
    const agent = await loginAsAgent('member');
    const res = await agent.get('/api/tenders?hasWinners=false');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });

  it('GET /api/tenders rejects invalid query params with 400', async () => {
    const agent = await loginAsAgent('member');
    const res = await agent.get('/api/tenders?status=maybe');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('GET /api/tenders/facets returns distinct values including fieldCodes', async () => {
    await repo.mergeMany([patch(), patch({ ministry: 'KEMENTERIAN B', fieldCodes: ['010101'] })]);
    const agent = await loginAsAgent('member');
    const res = await agent.get('/api/tenders/facets');
    expect(res.status).toBe(200);
    expect(res.body.ministries).toEqual(['KEMENTERIAN A', 'KEMENTERIAN B']);
    expect(res.body.fieldCodes).toEqual(['010101']);
  });

  it('GET /api/dashboard returns awarded-tender aggregate stats', async () => {
    await repo.mergeMany([
      patch({
        status: 'closed', ministry: 'KEMENTERIAN A', closingDate: '2025-01-10',
        winners: [{ name: 'ACME SDN BHD', price: 500 }],
      }),
      patch({ status: 'open' }),
    ]);
    const agent = await loginAsAgent('member');
    const res = await agent.get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.totalAwardedCount).toBe(1);
    expect(res.body.totalAwardedValue).toBe(500);
    expect(res.body.byMinistry).toEqual([{ ministry: 'KEMENTERIAN A', totalValue: 500, count: 1 }]);
  });

  it('GET /api/tenders/:refNo returns { tender } by reference number; 404 when missing', async () => {
    await repo.mergeMany([patch({ dedupKey: 'UTHM/54/P/02', referenceNo: 'UTHM/54/P/02' })]);
    const agent = await loginAsAgent('member');
    const res = await agent.get(`/api/tenders/${encodeURIComponent('UTHM/54/P/02')}`);
    expect(res.status).toBe(200);
    expect(res.body.tender.referenceNo).toBe('UTHM/54/P/02');

    const missing = await agent.get('/api/tenders/NOPE');
    expect(missing.status).toBe(404);
  });

  it('POST /api/scrape starts an open-scope scrape (202) and 409s while running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let receivedScope: string | undefined;
    const blockingManager = new ScrapeManager(
      [{ name: 'fake', scrape: async (scope: string, _h: ScrapeHooks) => { receivedScope = scope; await gate; }, archiveJobNames: () => [] }],
      repo,
    );
    const app2 = createApp({ repo, tendersCollection, manager: blockingManager, ...authDeps() });
    const agent = await loginAsAgent('admin', app2);

    const first = await agent.post('/api/scrape');
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ started: true });
    expect(receivedScope).toBe('open');

    const second = await agent.post('/api/scrape');
    expect(second.status).toBe(409);

    const status = await agent.get('/api/scrape/status');
    expect(status.body.state).toBe('running');
    release();
  });

  it('GET /api/scrape/status is idle initially', async () => {
    const agent = await loginAsAgent('member');
    const res = await agent.get('/api/scrape/status');
    expect(res.body).toEqual({ state: 'idle' });
  });

  it('GET /api/sources returns name, lastScrapedAt, lastArchiveBackfillAt, and total per registered adapter', async () => {
    const fakeAdapter = { name: 'span', scrape: async () => {}, archiveJobNames: () => [] };
    const mgr = new ScrapeManager([fakeAdapter], repo);
    const app2 = createApp({ repo, tendersCollection, manager: mgr, ...authDeps() });
    const agent = await loginAsAgent('member', app2);
    const res = await agent.get('/api/sources');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ name: 'span', lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 }]);
  });

  it('POST /api/scrape accepts source and scope=full, running only that adapter with the manager\'s "all" scope', async () => {
    const scrapedBy: string[] = [];
    let receivedScope: string | undefined;
    const adapterA = { name: 'a', scrape: async () => { scrapedBy.push('a'); }, archiveJobNames: () => [] };
    const adapterB = {
      name: 'b',
      scrape: async (scope: string) => { scrapedBy.push('b'); receivedScope = scope; },
      archiveJobNames: () => [],
    };
    const mgr = new ScrapeManager([adapterA, adapterB], repo);
    const app2 = createApp({ repo, tendersCollection, manager: mgr, ...authDeps() });
    const agent = await loginAsAgent('admin', app2);
    const res = await agent.post('/api/scrape').send({ source: 'b', scope: 'full' });
    expect(res.status).toBe(202);
    await waitUntilNotRunning(agent);
    expect(scrapedBy).toEqual(['b']);
    expect(receivedScope).toBe('all');
  });

  it('POST /api/scrape rejects an invalid scope value with 400', async () => {
    const agent = await loginAsAgent('admin');
    const res = await agent.post('/api/scrape').send({ scope: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('POST /api/scrape with scope=results refreshes only that source\'s results jobs (202), and 409s when the adapter has none', async () => {
    await repo.setMeta('myprocurement', { completedArchiveJobs: ['closed-quotation', 'closed-quotation-results'] });
    const scrapedScopes: string[] = [];
    const adapter = {
      name: 'myprocurement',
      scrape: async (scope: string) => { scrapedScopes.push(scope); },
      archiveJobNames: () => ['closed-quotation', 'closed-quotation-results'],
      resultsJobNames: () => ['closed-quotation-results'],
    };
    const mgr = new ScrapeManager([adapter], repo);
    const app2 = createApp({ repo, tendersCollection, manager: mgr, ...authDeps() });
    const agent2 = await loginAsAgent('admin', app2);

    const res = await agent2.post('/api/scrape').send({ source: 'myprocurement', scope: 'results' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ started: true });
    await waitUntilNotRunning(agent2);
    expect(scrapedScopes).toEqual(['archive']);
    expect((await repo.getMeta('myprocurement')).completedArchiveJobs).toEqual(['closed-quotation']);

    const noResultsAdapter = { name: 'span', scrape: async () => {}, archiveJobNames: () => [], resultsJobNames: () => [] };
    const mgr2 = new ScrapeManager([noResultsAdapter], repo);
    const app3 = createApp({ repo, tendersCollection, manager: mgr2, ...authDeps() });
    const agent3 = await loginAsAgent('admin', app3);
    const res2 = await agent3.post('/api/scrape').send({ source: 'span', scope: 'results' });
    expect(res2.status).toBe(409);
  });

  it('POST /api/scrape with scope=results and no source returns 400', async () => {
    const agent = await loginAsAgent('admin');
    const res = await agent.post('/api/scrape').send({ scope: 'results' });
    expect(res.status).toBe(400);
  });

  it('POST /api/scrape/cancel cancels a running scrape (200) and 409s when nothing is running', async () => {
    const agent = await loginAsAgent('admin');
    const idle = await agent.post('/api/scrape/cancel');
    expect(idle.status).toBe(409);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const blockingAdapter = { name: 'fake', scrape: async () => { await gate; }, archiveJobNames: () => [] };
    const blockingManager = new ScrapeManager([blockingAdapter], repo);
    const app2 = createApp({ repo, tendersCollection, manager: blockingManager, ...authDeps() });
    const agent2 = await loginAsAgent('admin', app2);
    await agent2.post('/api/scrape');
    const res = await agent2.post('/api/scrape/cancel');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: true });
    release();
  });
});
