import { describe, expect, it } from 'vitest';
import type { Tender, TenderPatch } from '@tms/shared';
import { TenderRepository } from '../src/storage/repository.js';
import type { SourceMetaDoc } from '../src/storage/repository.js';
import type { TenderDoc } from '../src/storage/tenderDoc.js';
import { FakeCollection } from './support/fakeMongoCollection.js';

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
  const tenders = new FakeCollection<TenderDoc>();
  const sourceMeta = new FakeCollection<SourceMetaDoc>();
  return { tenders, sourceMeta, repo: new TenderRepository(tenders, sourceMeta) };
}

describe('TenderRepository', () => {
  it('starts empty and reports missing sources', async () => {
    const { repo } = freshRepo();
    expect(await repo.getAll()).toEqual([]);
    expect(await repo.hasSource('myprocurement')).toBe(false);
  });

  it('seeds a new merged record from the first patch, defaulting unobserved fields', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch()]);
    const [t] = await repo.getAll();
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
    await repo.mergeMany([makePatch({ ministry: 'OLD', scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    await repo.mergeMany([makePatch({ ministry: 'NEW', scrapedAt: '2026-07-07T00:00:00.000Z' })]);
    expect((await repo.getAll())[0]!.ministry).toBe('NEW');
  });

  it('never lets a null value clobber an already-known value, even if the patch is newer', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ ministry: 'KNOWN', scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    await repo.mergeMany([makePatch({ ministry: null, scrapedAt: '2026-07-07T00:00:00.000Z' })]);
    expect((await repo.getAll())[0]!.ministry).toBe('KNOWN');
  });

  it("never lets a different source's unclassifiable (null) procurementType clobber an already-known type", async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ procurementType: 'tender', scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    await repo.mergeMany([makePatch({
      procurementType: null,
      scrapedAt: '2026-07-07T00:00:00.000Z',
      source: { source: 'span', sourceId: '9', sourceUrl: 'https://www.span.gov.my/tender/view/9' },
    })]);
    expect((await repo.getAll())[0]!.procurementType).toBe('tender');
  });

  it("never lets a different source without fieldCodes/winners erase values another source already contributed", async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({
      fieldCodes: ['E05'],
      winners: [{ name: 'X', price: 1 }],
      scrapedAt: '2026-07-01T00:00:00.000Z',
    })]);
    await repo.mergeMany([makePatch({
      scrapedAt: '2026-07-07T00:00:00.000Z',
      source: { source: 'span', sourceId: '9', sourceUrl: 'https://www.span.gov.my/tender/view/9' },
    })]);
    const [t] = await repo.getAll();
    expect(t!.fieldCodes).toEqual(['E05']);
    expect(t!.winners).toEqual([{ name: 'X', price: 1 }]);
  });

  it("KWSP: preserves an open tender's advertisedDate AND closingDate when a later results patch (same dedupKey) never observed them, while updating status/winners", async () => {
    const { repo } = freshRepo();
    const openSource = {
      source: 'kwsp', sourceId: 'sample-doc',
      sourceUrl: 'https://www.kwsp.gov.my/documents/d/guest/sample-doc',
    };
    const resultsSource = {
      source: 'kwsp', sourceId: 'Doc1234567890',
      sourceUrl: 'https://www.kwsp.gov.my/en/corporate/procurement/tenders',
    };
    await repo.mergeMany([makePatch({
      dedupKey: 'DOC1234567890', referenceNo: 'Doc1234567890', title: 'Sample KWSP Tender',
      procurementType: 'tender',
      advertisedDate: '2026-07-01', closingDate: '2026-07-15',
      scrapedAt: '2026-07-01T00:00:00.000Z', source: openSource,
    })]);
    await repo.mergeMany([makePatch({
      dedupKey: 'DOC1234567890', referenceNo: 'Doc1234567890', title: 'Sample KWSP Tender',
      status: 'closed', procurementType: 'tender',
      scrapedAt: '2026-08-05T00:00:00.000Z', source: resultsSource,
      winners: [{ name: 'Winner Sdn Bhd', price: null }],
    })]);
    const [t] = await repo.getAll();
    expect(t!.status).toBe('closed');
    expect(t!.winners).toEqual([{ name: 'Winner Sdn Bhd', price: null }]);
    expect(t!.closingDate).toBe('2026-07-15');
    expect(t!.advertisedDate).toBe('2026-07-01');
    expect(t!.sources).toEqual([resultsSource]);
  });

  it('ignores an older (out-of-order) patch for a field already set by a newer one', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ ministry: 'NEWER', scrapedAt: '2026-07-07T00:00:00.000Z' })]);
    await repo.mergeMany([makePatch({ ministry: 'STALE', scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    expect((await repo.getAll())[0]!.ministry).toBe('NEWER');
  });

  it('leaves a field untouched when a later patch never observed it', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ fieldCodes: ['010101'], scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    await repo.mergeMany([makePatch({ winners: [{ name: 'X', price: 1 }], scrapedAt: '2026-07-07T00:00:00.000Z' })]);
    const [t] = await repo.getAll();
    expect(t!.fieldCodes).toEqual(['010101']);
    expect(t!.winners).toEqual([{ name: 'X', price: 1 }]);
  });

  it('accumulates distinct sources and updates an existing source entry in place', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch()]);
    await repo.mergeMany([makePatch({ source: { source: 'otherSource', sourceId: '9', sourceUrl: 'https://other.example/9' } })]);
    expect((await repo.getAll())[0]!.sources).toHaveLength(2);
    await repo.mergeMany([makePatch({ source: { source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1-updated' } })]);
    const sources = (await repo.getAll())[0]!.sources;
    expect(sources).toHaveLength(2);
    expect(sources.find((s) => s.source === 'myprocurement')?.sourceUrl).toBe('https://example.com/1-updated');
  });

  it('findByDedupKey returns the merged record or null', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch()]);
    expect((await repo.findByDedupKey('REF/1'))?.title).toBe('T1');
    expect(await repo.findByDedupKey('NOPE')).toBeNull();
  });

  it('getSourceCount counts merged records with a contribution from that source', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ dedupKey: 'A', referenceNo: 'A' })]);
    await repo.mergeMany([makePatch({ dedupKey: 'B', referenceNo: 'B', source: { source: 'other', sourceId: '1', sourceUrl: 'https://x/1' } })]);
    expect(await repo.getSourceCount('myprocurement')).toBe(1);
    expect(await repo.getSourceCount('other')).toBe(1);
    expect(await repo.getSourceCount('nope')).toBe(0);
  });

  it('a second repository instance backed by the same underlying collection sees merged data and respects provenance', async () => {
    const { tenders, sourceMeta, repo } = freshRepo();
    await repo.mergeMany([makePatch()]);

    const repo2 = new TenderRepository(tenders, sourceMeta);
    expect(await repo2.getAll()).toHaveLength(1);
    await repo2.mergeMany([makePatch({ title: 'STALE TITLE', scrapedAt: '2026-01-01T00:00:00.000Z' })]);
    expect((await repo2.getAll())[0]!.title).toBe('T1');
  });

  it('meta defaults, patches, and persists per source; hasSource reflects a completed scrape', async () => {
    const { tenders, sourceMeta, repo } = freshRepo();
    expect(await repo.getMeta('myprocurement')).toEqual({
      lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0, completedArchiveJobs: [],
    });
    expect(await repo.hasSource('myprocurement')).toBe(false);
    await repo.setMeta('myprocurement', { lastArchiveBackfillAt: '2026-07-07T00:00:00.000Z', total: 5 });
    expect(await repo.hasSource('myprocurement')).toBe(true);

    const repo2 = new TenderRepository(tenders, sourceMeta);
    expect((await repo2.getMeta('myprocurement')).lastArchiveBackfillAt).toBe('2026-07-07T00:00:00.000Z');
    expect(await repo2.hasSource('myprocurement')).toBe(true);
  });

  it('persists completedArchiveJobs across reloads (backfill-completeness per job kind)', async () => {
    const { tenders, sourceMeta, repo } = freshRepo();
    await repo.setMeta('myprocurement', { completedArchiveJobs: ['closed-quotation'] });
    await repo.setMeta('myprocurement', { completedArchiveJobs: ['closed-quotation', 'closed-tender'] });
    expect((await repo.getMeta('myprocurement')).completedArchiveJobs).toEqual(['closed-quotation', 'closed-tender']);

    const repo2 = new TenderRepository(tenders, sourceMeta);
    expect((await repo2.getMeta('myprocurement')).completedArchiveJobs).toEqual(['closed-quotation', 'closed-tender']);
  });

  it('handles a large merge (archive scale) without quadratic behavior', async () => {
    const { repo } = freshRepo();
    const big = Array.from({ length: 20000 }, (_, i) => makePatch({ dedupKey: `REF/${i}`, referenceNo: `REF/${i}` }));
    const start = Date.now();
    await repo.mergeMany(big);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(await repo.getAll()).toHaveLength(20000);
  });

  it('flips an open tender to closed once past 12:01pm MYT on its closing date', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ closingDate: '2026-07-10' })]);
    const count = await repo.reconcileStaleOpen(new Date('2026-07-10T04:02:00.000Z'));
    expect(count).toBe(1);
    expect((await repo.getAll())[0]!.status).toBe('closed');
  });

  it('leaves it open before the 12:01pm MYT cutoff on the same day', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ closingDate: '2026-07-10' })]);
    const count = await repo.reconcileStaleOpen(new Date('2026-07-10T03:00:00.000Z'));
    expect(count).toBe(0);
    expect((await repo.getAll())[0]!.status).toBe('open');
  });

  it('flips exactly at the 12:01pm MYT cutoff instant', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ closingDate: '2026-07-10' })]);
    const count = await repo.reconcileStaleOpen(new Date('2026-07-10T04:01:00.000Z'));
    expect(count).toBe(1);
    expect((await repo.getAll())[0]!.status).toBe('closed');
  });

  it('leaves an already-closed tender untouched', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ status: 'closed', closingDate: '2020-01-01' })]);
    const count = await repo.reconcileStaleOpen(new Date('2026-07-10T00:00:00.000Z'));
    expect(count).toBe(0);
    expect((await repo.getAll())[0]!.status).toBe('closed');
  });

  it('flips a closing-date-less open tender to closed once more than a month past advertisedDate', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ advertisedDate: '2026-01-15' })]);
    const count = await repo.reconcileStaleOpen(new Date('2026-02-16T00:00:00+08:00'));
    expect(count).toBe(1);
    expect((await repo.getAll())[0]!.status).toBe('closed');
  });

  it('leaves a closing-date-less open tender open at exactly one month and just under', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([
      makePatch({ dedupKey: 'A', referenceNo: 'A', advertisedDate: '2026-01-15' }),
      makePatch({ dedupKey: 'B', referenceNo: 'B', advertisedDate: '2026-01-15' }),
    ]);
    const exactlyOneMonth = await repo.reconcileStaleOpen(new Date('2026-02-15T00:00:00+08:00'));
    expect(exactlyOneMonth).toBe(0);
    const justUnder = await repo.reconcileStaleOpen(new Date('2026-02-14T00:00:00+08:00'));
    expect(justUnder).toBe(0);
    expect((await repo.findByDedupKey('A'))!.status).toBe('open');
    expect((await repo.findByDedupKey('B'))!.status).toBe('open');
  });

  it('clamps the one-month fallback to the last day of a shorter target month', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ advertisedDate: '2026-01-31' })]);
    const stillOpen = await repo.reconcileStaleOpen(new Date('2026-02-28T00:00:00+08:00'));
    expect(stillOpen).toBe(0);
    const nowClosed = await repo.reconcileStaleOpen(new Date('2026-03-01T00:00:00+08:00'));
    expect(nowClosed).toBe(1);
    expect((await repo.getAll())[0]!.status).toBe('closed');
  });

  it('leaves a tender with neither closingDate nor advertisedDate untouched', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch()]);
    const count = await repo.reconcileStaleOpen(new Date('2030-01-01T00:00:00.000Z'));
    expect(count).toBe(0);
    expect((await repo.getAll())[0]!.status).toBe('open');
  });

  it('does not update provenance for status, so a later genuine patch can still overwrite it', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ closingDate: '2026-01-05', scrapedAt: '2026-01-01T00:00:00.000Z' })]);
    const staleCount = await repo.reconcileStaleOpen(new Date('2026-06-01T00:00:00.000Z'));
    expect(staleCount).toBe(1);
    expect((await repo.getAll())[0]!.status).toBe('closed');

    await repo.mergeMany([makePatch({ status: 'open', scrapedAt: '2026-02-01T00:00:00.000Z' })]);
    expect((await repo.getAll())[0]!.status).toBe('open');
  });

  it('returns the count of records changed, ignoring ones that are not eligible', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([
      makePatch({ dedupKey: 'STALE/1', referenceNo: 'STALE/1', closingDate: '2020-01-01' }),
      makePatch({ dedupKey: 'STALE/2', referenceNo: 'STALE/2', closingDate: '2021-01-01' }),
      makePatch({ dedupKey: 'FRESH/1', referenceNo: 'FRESH/1', closingDate: '2030-01-01' }),
    ]);
    const count = await repo.reconcileStaleOpen(new Date('2026-07-10T00:00:00.000Z'));
    expect(count).toBe(2);
    expect((await repo.findByDedupKey('STALE/1'))!.status).toBe('closed');
    expect((await repo.findByDedupKey('STALE/2'))!.status).toBe('closed');
    expect((await repo.findByDedupKey('FRESH/1'))!.status).toBe('open');
  });

  it('findAwarded returns only closed tenders with at least one winner', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([
      makePatch({ dedupKey: 'A', referenceNo: 'A', status: 'closed', winners: [{ name: 'X', price: 1 }] }),
      makePatch({ dedupKey: 'B', referenceNo: 'B', status: 'closed', winners: [] }),
      makePatch({ dedupKey: 'C', referenceNo: 'C', status: 'closed', winners: null }),
      makePatch({ dedupKey: 'D', referenceNo: 'D', status: 'open' }),
    ]);
    const awarded = await repo.findAwarded();
    expect(awarded).toHaveLength(1);
    expect(awarded[0]!.dedupKey).toBe('A');
  });
});
