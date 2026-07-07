import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Tender } from '@tms/shared';
import { createApp } from '../src/api/app.js';
import { ScrapeManager } from '../src/scrape/manager.js';
import type { ScrapeHooks } from '../src/scrapers/types.js';
import { TenderRepository } from '../src/storage/repository.js';

let seq = 0;
function t(overrides: Partial<Tender> = {}): Tender {
  seq += 1;
  return {
    id: `myprocurement:${seq}`, source: 'myprocurement', sourceId: String(seq),
    referenceNo: `REF/${seq}`, dedupKey: `REF/${seq}`, title: `TENDER ${seq}`,
    sourceUrl: `https://example.com/${seq}`, status: 'open', procurementType: 'quotation',
    ministry: 'KEMENTERIAN A', agency: null, category: null, fieldCodes: [],
    advertisedDate: '2026-07-01', closingDate: null, indicativePrice: null,
    currency: 'MYR', events: [], raw: {}, scrapedAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  };
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
    repo.upsertMany('myprocurement', [t({ title: 'BUMBUNG GELANGGANG' }), t({ status: 'closed' }), t()]);
    const all = await request(app).get('/api/tenders');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.page).toBe(1);

    const filtered = await request(app).get('/api/tenders?status=closed');
    expect(filtered.body.total).toBe(1);

    const searched = await request(app).get('/api/tenders?search=bumbung');
    expect(searched.body.total).toBe(1);
  });

  it('GET /api/tenders rejects invalid query params with 400', async () => {
    const res = await request(app).get('/api/tenders?status=maybe');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('GET /api/tenders/facets returns distinct values', async () => {
    repo.upsertMany('myprocurement', [t(), t({ ministry: 'KEMENTERIAN B' })]);
    const res = await request(app).get('/api/tenders/facets');
    expect(res.status).toBe(200);
    expect(res.body.ministries).toEqual(['KEMENTERIAN A', 'KEMENTERIAN B']);
  });

  it('GET /api/tenders/:id returns tender with alsoAvailableFrom; 404 when missing', async () => {
    const a = t({ dedupKey: 'SAME' });
    const b = t({ id: 'other:1', source: 'other', dedupKey: 'SAME' });
    repo.upsertMany('myprocurement', [a]);
    repo.upsertMany('other', [b]);
    const res = await request(app).get(`/api/tenders/${encodeURIComponent(a.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.tender.id).toBe(a.id);
    expect(res.body.alsoAvailableFrom).toHaveLength(1);

    const missing = await request(app).get('/api/tenders/nope:1');
    expect(missing.status).toBe(404);
  });

  it('POST /api/scrape starts an open-scope scrape (202) and 409s while running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let receivedScope: string | undefined;
    const blockingManager = new ScrapeManager(
      [{ name: 'fake', scrape: async (scope: string, _h: ScrapeHooks) => { receivedScope = scope; await gate; } }],
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
});
