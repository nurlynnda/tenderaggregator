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

  it('never lets a different source\'s unclassifiable (null) procurementType clobber an already-known type', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ procurementType: 'tender', scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    repo.mergeMany([makePatch({
      procurementType: null,
      scrapedAt: '2026-07-07T00:00:00.000Z',
      source: { source: 'span', sourceId: '9', sourceUrl: 'https://www.span.gov.my/tender/view/9' },
    })]);
    expect(repo.getAll()[0]!.procurementType).toBe('tender');
  });

  it('never lets a different source without fieldCodes/winners erase values another source already contributed', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({
      fieldCodes: ['E05'],
      winners: [{ name: 'X', price: 1 }],
      scrapedAt: '2026-07-01T00:00:00.000Z',
    })]);
    // A real span.gov.my patch never observes fieldCodes/winners, so it omits those keys
    // entirely rather than sending [] — this proves that omission, not a source, protects them.
    repo.mergeMany([makePatch({
      scrapedAt: '2026-07-07T00:00:00.000Z',
      source: { source: 'span', sourceId: '9', sourceUrl: 'https://www.span.gov.my/tender/view/9' },
    })]);
    const [t] = repo.getAll();
    expect(t!.fieldCodes).toEqual(['E05']);
    expect(t!.winners).toEqual([{ name: 'X', price: 1 }]);
  });

  it('KWSP: preserves an open tender\'s advertisedDate when a later results patch (same dedupKey) never observed it, while updating status/closingDate/winners', async () => {
    const { repo } = freshRepo();
    await repo.load();
    const openSource = {
      source: 'kwsp', sourceId: 'sample-doc',
      sourceUrl: 'https://www.kwsp.gov.my/documents/d/guest/sample-doc',
    };
    const resultsSource = {
      source: 'kwsp', sourceId: 'Doc1234567890',
      sourceUrl: 'https://www.kwsp.gov.my/en/corporate/procurement/tenders',
    };
    repo.mergeMany([makePatch({
      dedupKey: 'DOC1234567890', referenceNo: 'Doc1234567890', title: 'Sample KWSP Tender',
      procurementType: 'tender',
      advertisedDate: '2026-07-01', closingDate: '2026-07-15',
      scrapedAt: '2026-07-01T00:00:00.000Z', source: openSource,
    })]);
    repo.mergeMany([makePatch({
      dedupKey: 'DOC1234567890', referenceNo: 'Doc1234567890', title: 'Sample KWSP Tender',
      status: 'closed', procurementType: 'tender', closingDate: '2026-08-01',
      scrapedAt: '2026-08-05T00:00:00.000Z', source: resultsSource,
      winners: [{ name: 'Winner Sdn Bhd', price: null }],
    })]);
    const [t] = repo.getAll();
    expect(t!.status).toBe('closed');
    expect(t!.winners).toEqual([{ name: 'Winner Sdn Bhd', price: null }]);
    expect(t!.closingDate).toBe('2026-08-01'); // the results patch's own (newer) value wins
    expect(t!.advertisedDate).toBe('2026-07-01'); // never observed by the results patch — untouched
    expect(t!.sources).toEqual([resultsSource]);
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

  it('serializes concurrent flush() calls so their writes never interleave', async () => {
    const { dir, repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch()]);
    // Fire many overlapping flushes concurrently — before the fix, interleaved
    // temp-file writes/renames could throw or leave tenders.json corrupted.
    await Promise.all([repo.flush(), repo.flush(), repo.flush(), repo.flush(), repo.flush()]);
    const onDisk = JSON.parse(readFileSync(join(dir, 'tenders.json'), 'utf8'));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].dedupKey).toBe('REF/1');
  });

  it('meta defaults, patches, and persists per source; hasSource reflects a completed scrape', async () => {
    const { dir, repo } = freshRepo();
    await repo.load();
    expect(repo.getMeta('myprocurement')).toEqual({
      lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0, completedArchiveJobs: [],
    });
    expect(repo.hasSource('myprocurement')).toBe(false);
    await repo.setMeta('myprocurement', { lastArchiveBackfillAt: '2026-07-07T00:00:00.000Z', total: 5 });
    expect(repo.hasSource('myprocurement')).toBe(true);

    const repo2 = new TenderRepository(dir);
    await repo2.load();
    expect(repo2.getMeta('myprocurement').lastArchiveBackfillAt).toBe('2026-07-07T00:00:00.000Z');
    expect(repo2.hasSource('myprocurement')).toBe(true);
  });

  it('persists completedArchiveJobs across reloads (backfill-completeness per job kind)', async () => {
    const { dir, repo } = freshRepo();
    await repo.load();
    await repo.setMeta('myprocurement', { completedArchiveJobs: ['closed-quotation'] });
    await repo.setMeta('myprocurement', { completedArchiveJobs: ['closed-quotation', 'closed-tender'] });
    expect(repo.getMeta('myprocurement').completedArchiveJobs).toEqual(['closed-quotation', 'closed-tender']);

    const repo2 = new TenderRepository(dir);
    await repo2.load();
    expect(repo2.getMeta('myprocurement').completedArchiveJobs).toEqual(['closed-quotation', 'closed-tender']);
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

  it('flips an open tender to closed once past 12:01pm MYT on its closing date', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ closingDate: '2026-07-10' })]);
    const count = repo.reconcileStaleOpen(new Date('2026-07-10T04:02:00.000Z')); // 12:02pm MYT
    expect(count).toBe(1);
    expect(repo.getAll()[0]!.status).toBe('closed');
  });

  it('leaves it open before the 12:01pm MYT cutoff on the same day', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ closingDate: '2026-07-10' })]);
    const count = repo.reconcileStaleOpen(new Date('2026-07-10T03:00:00.000Z')); // 11:00am MYT
    expect(count).toBe(0);
    expect(repo.getAll()[0]!.status).toBe('open');
  });

  it('flips exactly at the 12:01pm MYT cutoff instant', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ closingDate: '2026-07-10' })]);
    const count = repo.reconcileStaleOpen(new Date('2026-07-10T04:01:00.000Z')); // exactly 12:01pm MYT
    expect(count).toBe(1);
    expect(repo.getAll()[0]!.status).toBe('closed');
  });

  it('leaves an already-closed tender untouched', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ status: 'closed', closingDate: '2020-01-01' })]);
    const count = repo.reconcileStaleOpen(new Date('2026-07-10T00:00:00.000Z'));
    expect(count).toBe(0);
    expect(repo.getAll()[0]!.status).toBe('closed');
  });

  it('flips a closing-date-less open tender to closed once more than a month past advertisedDate', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ advertisedDate: '2026-01-15' })]);
    const count = repo.reconcileStaleOpen(new Date('2026-02-16T00:00:00+08:00'));
    expect(count).toBe(1);
    expect(repo.getAll()[0]!.status).toBe('closed');
  });

  it('leaves a closing-date-less open tender open at exactly one month and just under', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([
      makePatch({ dedupKey: 'A', referenceNo: 'A', advertisedDate: '2026-01-15' }),
      makePatch({ dedupKey: 'B', referenceNo: 'B', advertisedDate: '2026-01-15' }),
    ]);
    const exactlyOneMonth = repo.reconcileStaleOpen(new Date('2026-02-15T00:00:00+08:00'));
    expect(exactlyOneMonth).toBe(0);
    const justUnder = repo.reconcileStaleOpen(new Date('2026-02-14T00:00:00+08:00'));
    expect(justUnder).toBe(0);
    expect(repo.findByDedupKey('A')!.status).toBe('open');
    expect(repo.findByDedupKey('B')!.status).toBe('open');
  });

  it('clamps the one-month fallback to the last day of a shorter target month', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ advertisedDate: '2026-01-31' })]);
    // 2026 is not a leap year, so Feb has 28 days -> cutoff is 2026-02-28T00:00:00+08:00,
    // not 2026-03-03 (which the old setUTCMonth(+1) overflow used to produce).
    const stillOpen = repo.reconcileStaleOpen(new Date('2026-02-28T00:00:00+08:00'));
    expect(stillOpen).toBe(0);
    const nowClosed = repo.reconcileStaleOpen(new Date('2026-03-01T00:00:00+08:00'));
    expect(nowClosed).toBe(1);
    expect(repo.getAll()[0]!.status).toBe('closed');
  });

  it('leaves a tender with neither closingDate nor advertisedDate untouched', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch()]); // no closingDate, no advertisedDate override -> both null
    const count = repo.reconcileStaleOpen(new Date('2030-01-01T00:00:00.000Z'));
    expect(count).toBe(0);
    expect(repo.getAll()[0]!.status).toBe('open');
  });

  it('does not update field-provenance.json for status, so a later genuine patch can still overwrite it', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ closingDate: '2026-01-05', scrapedAt: '2026-01-01T00:00:00.000Z' })]);
    const staleCount = repo.reconcileStaleOpen(new Date('2026-06-01T00:00:00.000Z'));
    expect(staleCount).toBe(1);
    expect(repo.getAll()[0]!.status).toBe('closed');

    // A genuine patch dated after the ORIGINAL scrape (but well before reconcile's `now`)
    // must still be able to overwrite status — proving reconcile never touched provenance.
    repo.mergeMany([makePatch({ status: 'open', scrapedAt: '2026-02-01T00:00:00.000Z' })]);
    expect(repo.getAll()[0]!.status).toBe('open');
  });

  it('returns the count of records changed, ignoring ones that are not eligible', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([
      makePatch({ dedupKey: 'STALE/1', referenceNo: 'STALE/1', closingDate: '2020-01-01' }),
      makePatch({ dedupKey: 'STALE/2', referenceNo: 'STALE/2', closingDate: '2021-01-01' }),
      makePatch({ dedupKey: 'FRESH/1', referenceNo: 'FRESH/1', closingDate: '2030-01-01' }),
    ]);
    const count = repo.reconcileStaleOpen(new Date('2026-07-10T00:00:00.000Z'));
    expect(count).toBe(2);
    expect(repo.findByDedupKey('STALE/1')!.status).toBe('closed');
    expect(repo.findByDedupKey('STALE/2')!.status).toBe('closed');
    expect(repo.findByDedupKey('FRESH/1')!.status).toBe('open');
  });
});
