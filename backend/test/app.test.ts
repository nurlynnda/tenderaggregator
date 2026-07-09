import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TenderPatch } from '@tms/shared';
import { createApp } from '../src/api/app.js';
import { ScrapeManager } from '../src/scrape/manager.js';
import type { ScrapeHooks } from '../src/scrapers/types.js';
import { TenderRepository } from '../src/storage/repository.js';

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

async function waitUntilNotRunning(app: ReturnType<typeof createApp>): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const res = await request(app).get('/api/scrape/status');
    if (res.body.state !== 'running') return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitUntilNotRunning: timed out');
}

describe('API', () => {
  let repo: TenderRepository;
  let manager: ScrapeManager;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    repo = new TenderRepository(mkdtempSync(join(tmpdir(), 'tms-app-')));
    await repo.load();
    manager = new ScrapeManager([], repo);
    app = createApp({ repo, manager });
  });

  it('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api/tenders returns paginated, filterable results', async () => {
    repo.mergeMany([patch({ title: 'BUMBUNG GELANGGANG' }), patch({ status: 'closed' }), patch()]);
    const all = await request(app).get('/api/tenders');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.page).toBe(1);

    const filtered = await request(app).get('/api/tenders?status=closed');
    expect(filtered.body.total).toBe(1);

    const searched = await request(app).get('/api/tenders?search=bumbung');
    expect(searched.body.total).toBe(1);
  });

  it('GET /api/tenders supports fieldCode and hasWinners filters', async () => {
    repo.mergeMany([
      patch({ fieldCodes: ['220801'] }),
      patch({ winners: [{ name: 'X', price: 1 }] }),
      patch(),
    ]);
    const byField = await request(app).get('/api/tenders?fieldCode=22');
    expect(byField.body.total).toBe(1);
    const awarded = await request(app).get('/api/tenders?hasWinners=true');
    expect(awarded.body.total).toBe(1);
  });

  it('GET /api/tenders supports a contractor filter matching any winner name', async () => {
    repo.mergeMany([
      patch({ winners: [{ name: 'SAFWORKS SDN. BHD.', price: 1 }] }),
      patch({ winners: [{ name: 'SUCEME ENTERPRISE', price: 2 }] }),
      patch(),
    ]);
    const res = await request(app).get('/api/tenders?contractor=SAFWORKS SDN. BHD.');
    expect(res.body.total).toBe(1);
  });

  it('GET /api/tenders?hasWinners=false returns unfiltered results, not awarded-only', async () => {
    repo.mergeMany([patch({ winners: [{ name: 'X', price: 1 }] }), patch(), patch()]);
    const res = await request(app).get('/api/tenders?hasWinners=false');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });

  it('GET /api/tenders rejects invalid query params with 400', async () => {
    const res = await request(app).get('/api/tenders?status=maybe');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('GET /api/tenders/facets returns distinct values including fieldCodes', async () => {
    repo.mergeMany([patch(), patch({ ministry: 'KEMENTERIAN B', fieldCodes: ['010101'] })]);
    const res = await request(app).get('/api/tenders/facets');
    expect(res.status).toBe(200);
    expect(res.body.ministries).toEqual(['KEMENTERIAN A', 'KEMENTERIAN B']);
    expect(res.body.fieldCodes).toEqual(['010101']);
  });

  it('GET /api/tenders/:refNo returns { tender } by reference number; 404 when missing', async () => {
    repo.mergeMany([patch({ dedupKey: 'UTHM/54/P/02', referenceNo: 'UTHM/54/P/02' })]);
    const res = await request(app).get(`/api/tenders/${encodeURIComponent('UTHM/54/P/02')}`);
    expect(res.status).toBe(200);
    expect(res.body.tender.referenceNo).toBe('UTHM/54/P/02');
    expect(res.body.alsoAvailableFrom).toBeUndefined(); // sources[] on the tender itself replaces this

    const missing = await request(app).get('/api/tenders/NOPE');
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
    const app2 = createApp({ repo, manager: blockingManager });

    const first = await request(app2).post('/api/scrape');
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ started: true });
    expect(receivedScope).toBe('open');

    const second = await request(app2).post('/api/scrape');
    expect(second.status).toBe(409);

    const status = await request(app2).get('/api/scrape/status');
    expect(status.body.state).toBe('running');
    release();
  });

  it('GET /api/scrape/status is idle initially', async () => {
    const res = await request(app).get('/api/scrape/status');
    expect(res.body).toEqual({ state: 'idle' });
  });

  it('GET /api/sources returns name, lastScrapedAt, lastArchiveBackfillAt, and total per registered adapter', async () => {
    const fakeAdapter = { name: 'span', scrape: async () => {}, archiveJobNames: () => [] };
    const mgr = new ScrapeManager([fakeAdapter], repo);
    const app2 = createApp({ repo, manager: mgr });
    const res = await request(app2).get('/api/sources');
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
    const app2 = createApp({ repo, manager: mgr });
    const res = await request(app2).post('/api/scrape').send({ source: 'b', scope: 'full' });
    expect(res.status).toBe(202);
    await waitUntilNotRunning(app2);
    expect(scrapedBy).toEqual(['b']);
    expect(receivedScope).toBe('all');
  });

  it('POST /api/scrape rejects an invalid scope value with 400', async () => {
    const res = await request(app).post('/api/scrape').send({ scope: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('POST /api/scrape/cancel cancels a running scrape (200) and 409s when nothing is running', async () => {
    const idle = await request(app).post('/api/scrape/cancel');
    expect(idle.status).toBe(409);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const blockingAdapter = { name: 'fake', scrape: async () => { await gate; }, archiveJobNames: () => [] };
    const blockingManager = new ScrapeManager([blockingAdapter], repo);
    const app2 = createApp({ repo, manager: blockingManager });
    await request(app2).post('/api/scrape');
    const res = await request(app2).post('/api/scrape/cancel');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: true });
    release();
  });
});
