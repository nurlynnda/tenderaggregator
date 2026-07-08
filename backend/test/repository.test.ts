import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Tender, TenderPatch } from '@tms/shared';
import { TenderRepository } from '../src/storage/repository.js';

function makePatch(overrides: Partial<TenderPatch> = {}): TenderPatch {
  return {
    dedupKey: 'REF/1', referenceNo: 'REF/1', title: 'T1',
    status: 'open', procurementType: 'quotation',
    scrapedAt: '2026-07-07T00:00:00.000Z',
    source: { source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1' },
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

  it('seeds a new merged record from the first patch, defaulting unobserved fields', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch()]);
    const [t] = repo.getAll();
    expect(t).toEqual<Tender>({
      dedupKey: 'REF/1', referenceNo: 'REF/1', title: 'T1',
      status: 'open', procurementType: 'quotation',
      ministry: null, agency: null, category: null, fieldCodes: [],
      advertisedDate: null, closingDate: null, indicativePrice: null,
      currency: 'MYR', events: [], winners: null, raw: {},
      scrapedAt: '2026-07-07T00:00:00.000Z',
      sources: [{ source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1' }],
    });
  });

  it('overwrites a field when a newer patch observes it', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ ministry: 'OLD', scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    repo.mergeMany([makePatch({ ministry: 'NEW', scrapedAt: '2026-07-07T00:00:00.000Z' })]);
    expect(repo.getAll()[0]!.ministry).toBe('NEW');
  });

  it('never lets a null value clobber an already-known value, even if the patch is newer', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ ministry: 'KNOWN', scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    repo.mergeMany([makePatch({ ministry: null, scrapedAt: '2026-07-07T00:00:00.000Z' })]);
    expect(repo.getAll()[0]!.ministry).toBe('KNOWN');
  });

  it('ignores an older (out-of-order) patch for a field already set by a newer one', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ ministry: 'NEWER', scrapedAt: '2026-07-07T00:00:00.000Z' })]);
    repo.mergeMany([makePatch({ ministry: 'STALE', scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    expect(repo.getAll()[0]!.ministry).toBe('NEWER');
  });

  it('leaves a field untouched when a later patch never observed it', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ fieldCodes: ['010101'], scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    // A results-style enrichment patch: winners present, fieldCodes key absent entirely.
    repo.mergeMany([makePatch({ winners: [{ name: 'X', price: 1 }], scrapedAt: '2026-07-07T00:00:00.000Z' })]);
    const [t] = repo.getAll();
    expect(t!.fieldCodes).toEqual(['010101']);
    expect(t!.winners).toEqual([{ name: 'X', price: 1 }]);
  });

  it('accumulates distinct sources and updates an existing source entry in place', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch()]);
    repo.mergeMany([makePatch({ source: { source: 'otherSource', sourceId: '9', sourceUrl: 'https://other.example/9' } })]);
    expect(repo.getAll()[0]!.sources).toHaveLength(2);
    repo.mergeMany([makePatch({ source: { source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1-updated' } })]);
    const sources = repo.getAll()[0]!.sources;
    expect(sources).toHaveLength(2); // re-patch from an existing source updates, doesn't append
    expect(sources.find((s) => s.source === 'myprocurement')?.sourceUrl).toBe('https://example.com/1-updated');
  });

  it('findByDedupKey returns the merged record or null', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch()]);
    expect(repo.findByDedupKey('REF/1')?.title).toBe('T1');
    expect(repo.findByDedupKey('NOPE')).toBeNull();
  });

  it('getSourceCount counts merged records with a contribution from that source', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ dedupKey: 'A', referenceNo: 'A' })]);
    repo.mergeMany([makePatch({ dedupKey: 'B', referenceNo: 'B', source: { source: 'other', sourceId: '1', sourceUrl: 'https://x/1' } })]);
    expect(repo.getSourceCount('myprocurement')).toBe(1);
    expect(repo.getSourceCount('other')).toBe(1);
    expect(repo.getSourceCount('nope')).toBe(0);
  });

  it('flush persists tenders.json and field-provenance.json atomically; load restores across instances', async () => {
    const { dir, repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch()]);
    await repo.flush();

    expect(readdirSync(dir)).toEqual(expect.arrayContaining(['tenders.json', 'field-provenance.json']));
    const onDisk = JSON.parse(readFileSync(join(dir, 'tenders.json'), 'utf8'));
    expect(onDisk).toHaveLength(1);

    const repo2 = new TenderRepository(dir);
    await repo2.load();
    expect(repo2.getAll()).toHaveLength(1);
    // Provenance survived the reload: an older patch for an already-set field must still be rejected.
    repo2.mergeMany([makePatch({ title: 'STALE TITLE', scrapedAt: '2026-01-01T00:00:00.000Z' })]);
    expect(repo2.getAll()[0]!.title).toBe('T1');
  });

  it('meta defaults, patches, and persists per source; hasSource reflects a completed scrape', async () => {
    const { dir, repo } = freshRepo();
    await repo.load();
    expect(repo.getMeta('myprocurement')).toEqual({ lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 });
    expect(repo.hasSource('myprocurement')).toBe(false);
    await repo.setMeta('myprocurement', { lastArchiveBackfillAt: '2026-07-07T00:00:00.000Z', total: 5 });
    expect(repo.hasSource('myprocurement')).toBe(true);

    const repo2 = new TenderRepository(dir);
    await repo2.load();
    expect(repo2.getMeta('myprocurement').lastArchiveBackfillAt).toBe('2026-07-07T00:00:00.000Z');
    expect(repo2.hasSource('myprocurement')).toBe(true);
  });

  it('rejects on load when tenders.json is corrupted', async () => {
    const { dir, repo } = freshRepo();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tenders.json'), '{not valid json', 'utf8');
    await expect(repo.load()).rejects.toThrow();
  });

  it('rejects on load when field-provenance.json is corrupted', async () => {
    const { dir, repo } = freshRepo();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'field-provenance.json'), '{not valid json', 'utf8');
    await expect(repo.load()).rejects.toThrow();
  });

  it('loads successfully with empty state when no files exist yet', async () => {
    const { repo } = freshRepo();
    await expect(repo.load()).resolves.toBeUndefined();
    expect(repo.getAll()).toEqual([]);
    expect(repo.hasSource('myprocurement')).toBe(false);
  });

  it('handles a large merge + flush (archive scale) without quadratic behavior', async () => {
    const { repo } = freshRepo();
    await repo.load();
    const big = Array.from({ length: 20000 }, (_, i) => makePatch({ dedupKey: `REF/${i}`, referenceNo: `REF/${i}` }));
    const start = Date.now();
    repo.mergeMany(big);
    await repo.flush();
    expect(Date.now() - start).toBeLessThan(5000);
    expect(repo.getAll()).toHaveLength(20000);
  });
});
