import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Tender } from '@tms/shared';
import { TenderRepository } from '../src/storage/repository.js';

function makeTender(overrides: Partial<Tender> = {}): Tender {
  return {
    id: 'myprocurement:1', source: 'myprocurement', sourceId: '1',
    referenceNo: 'REF/1', dedupKey: 'REF/1', title: 'T1',
    sourceUrl: 'https://example.com/1', status: 'open', procurementType: 'quotation',
    ministry: null, agency: null, category: null, fieldCodes: [],
    advertisedDate: null, closingDate: null, indicativePrice: null,
    currency: 'MYR', events: [], raw: {}, scrapedAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  };
}

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tms-repo-'));
  return { dir, repo: new TenderRepository(dir) };
}

describe('TenderRepository', () => {
  it('starts empty and reports missing sources', async () => {
    const { repo } = freshRepo();
    await repo.load();
    expect(repo.getAll()).toEqual([]);
    expect(repo.hasSource('myprocurement')).toBe(false);
  });

  it('upserts by id: new records added, existing replaced, delisted kept', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.upsertMany('myprocurement', [makeTender(), makeTender({ id: 'myprocurement:2', sourceId: '2', title: 'T2' })]);
    // second scrape: id 1 updated, id 2 absent (delisted), id 3 new
    repo.upsertMany('myprocurement', [makeTender({ title: 'T1-updated' }), makeTender({ id: 'myprocurement:3', sourceId: '3', title: 'T3' })]);
    const titles = repo.getAll().map((t) => t.title).sort();
    expect(titles).toEqual(['T1-updated', 'T2', 'T3']);
  });

  it('flush persists atomically and load restores across instances', async () => {
    const { dir, repo } = freshRepo();
    await repo.load();
    repo.upsertMany('myprocurement', [makeTender()]);
    await repo.flush('myprocurement');

    expect(readdirSync(join(dir, 'myprocurement'))).toContain('tenders.json'); // no .tmp left behind
    const onDisk = JSON.parse(readFileSync(join(dir, 'myprocurement', 'tenders.json'), 'utf8'));
    expect(onDisk).toHaveLength(1);

    const repo2 = new TenderRepository(dir);
    await repo2.load();
    expect(repo2.hasSource('myprocurement')).toBe(true);
    expect(repo2.getAll()).toHaveLength(1);
    expect(repo2.getMeta('myprocurement').total).toBe(1);
  });

  it('meta defaults, patches, and persists', async () => {
    const { dir, repo } = freshRepo();
    await repo.load();
    expect(repo.getMeta('myprocurement')).toEqual({ lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 });
    await repo.setMeta('myprocurement', { lastArchiveBackfillAt: '2026-07-07T00:00:00.000Z' });
    const repo2 = new TenderRepository(dir);
    await repo2.load();
    expect(repo2.getMeta('myprocurement').lastArchiveBackfillAt).toBe('2026-07-07T00:00:00.000Z');
  });

  it('rejects on load when tenders.json is corrupted, instead of silently treating source as missing', async () => {
    const { dir, repo } = freshRepo();
    mkdirSync(join(dir, 'myprocurement'), { recursive: true });
    writeFileSync(join(dir, 'myprocurement', 'tenders.json'), '{not valid json', 'utf8');

    await expect(repo.load()).rejects.toThrow();
  });

  it('loads successfully with hasSource false when source directory has no tenders.json', async () => {
    const { dir, repo } = freshRepo();
    mkdirSync(join(dir, 'myprocurement'), { recursive: true }); // dir exists, but no tenders.json inside

    await expect(repo.load()).resolves.toBeUndefined();
    expect(repo.hasSource('myprocurement')).toBe(false);
    expect(repo.getAll()).toEqual([]);
  });

  it('getDeduped caches the deduped view and invalidates it after upsertMany', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.upsertMany('myprocurement', [makeTender({ dedupKey: 'A' })]);

    const first = repo.getDeduped();
    expect(first).toHaveLength(1);
    const again = repo.getDeduped();
    expect(again).toBe(first); // same reference: served from cache, not recomputed

    repo.upsertMany('myprocurement', [makeTender({ id: 'myprocurement:2', sourceId: '2', dedupKey: 'B' })]);
    const afterUpsert = repo.getDeduped();
    expect(afterUpsert).toHaveLength(2); // reflects new data, not the stale cached array
    expect(afterUpsert).not.toBe(first);
  });

  it('handles large batch flush (archive scale) without quadratic behavior', async () => {
    const { repo } = freshRepo();
    await repo.load();
    const big = Array.from({ length: 20000 }, (_, i) =>
      makeTender({ id: `myprocurement:${i}`, sourceId: String(i), dedupKey: `REF/${i}` }));
    const start = Date.now();
    repo.upsertMany('myprocurement', big);
    await repo.flush('myprocurement');
    expect(Date.now() - start).toBeLessThan(5000);
    expect(repo.getAll()).toHaveLength(20000);
  });
});
