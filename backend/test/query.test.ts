import { describe, expect, it } from 'vitest';
import type { Tender } from '@tms/shared';
import { buildFacets, dedupeTenders, findById, queryTenders } from '../src/query/tenders.js';

let seq = 0;
function t(overrides: Partial<Tender> = {}): Tender {
  seq += 1;
  return {
    id: `myprocurement:${seq}`, source: 'myprocurement', sourceId: String(seq),
    referenceNo: `REF/${seq}`, dedupKey: `REF/${seq}`, title: `TENDER ${seq}`,
    sourceUrl: `https://example.com/${seq}`, status: 'open', procurementType: 'quotation',
    ministry: 'KEMENTERIAN A', agency: 'AGENSI A', category: 'Bekalan', fieldCodes: [],
    advertisedDate: '2026-07-01', closingDate: '2026-07-15', indicativePrice: 1000,
    currency: 'MYR', events: [], raw: {}, scrapedAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('dedupeTenders', () => {
  it('keeps one canonical record per dedupKey, preferring most non-null fields', () => {
    const sparse = t({ id: 'src2:1', source: 'src2', dedupKey: 'SAME', ministry: null, agency: null });
    const rich = t({ dedupKey: 'SAME' });
    expect(dedupeTenders([sparse, rich])).toEqual([rich]);
  });
  it('ties broken by newest scrapedAt', () => {
    const older = t({ dedupKey: 'SAME', scrapedAt: '2026-07-01T00:00:00.000Z' });
    const newer = t({ dedupKey: 'SAME', scrapedAt: '2026-07-07T00:00:00.000Z' });
    expect(dedupeTenders([older, newer])).toEqual([newer]);
  });
  it('never merges distinct dedupKeys', () => {
    expect(dedupeTenders([t(), t()])).toHaveLength(2);
  });
});

describe('queryTenders', () => {
  it('searches title and referenceNo case-insensitively', () => {
    const data = [t({ title: 'MEMBINA BUMBUNG' }), t({ referenceNo: 'KP/STRIDE/26', dedupKey: 'KP/STRIDE/26' }), t()];
    expect(queryTenders(data, { search: 'bumbung' }).items).toHaveLength(1);
    expect(queryTenders(data, { search: 'stride' }).items).toHaveLength(1);
  });

  it('filters by every supported field', () => {
    const data = [
      t({ ministry: 'KEMENTERIAN B' }),
      t({ status: 'closed' }),
      t({ procurementType: 'tender' }),
      t({ source: 'other', id: 'other:1' }),
      t({ agency: 'AGENSI B' }),
      t({ category: 'Kerja' }),
    ];
    expect(queryTenders(data, { ministry: 'KEMENTERIAN B' }).total).toBe(1);
    expect(queryTenders(data, { status: 'closed' }).total).toBe(1);
    expect(queryTenders(data, { procurementType: 'tender' }).total).toBe(1);
    expect(queryTenders(data, { source: 'other' }).total).toBe(1);
    expect(queryTenders(data, { agency: 'AGENSI B' }).total).toBe(1);
    expect(queryTenders(data, { category: 'Kerja' }).total).toBe(1);
  });

  it('sorts by price desc with nulls last, paginates with total', () => {
    const data = [t({ indicativePrice: 5 }), t({ indicativePrice: null }), t({ indicativePrice: 99 })];
    const page = queryTenders(data, { sortBy: 'indicativePrice', sortOrder: 'desc', page: 1, pageSize: 2 });
    expect(page.items.map((x) => x.indicativePrice)).toEqual([99, 5]);
    expect(page.total).toBe(3);
    const page2 = queryTenders(data, { sortBy: 'indicativePrice', sortOrder: 'desc', page: 2, pageSize: 2 });
    expect(page2.items.map((x) => x.indicativePrice)).toEqual([null]);
  });

  it('defaults: sorted by advertisedDate desc, page 1, pageSize 20, pageSize capped at 100', () => {
    const data = [t({ advertisedDate: '2026-01-01' }), t({ advertisedDate: '2026-06-01' })];
    const page = queryTenders(data, {});
    expect(page.items[0]!.advertisedDate).toBe('2026-06-01');
    expect(page.pageSize).toBe(20);
    expect(queryTenders(data, { pageSize: 5000 }).pageSize).toBe(100);
  });
});

describe('buildFacets', () => {
  it('returns sorted distinct values, omitting nulls', () => {
    const data = [
      t({ ministry: 'Z', agency: null, category: 'Kerja', procurementType: 'tender' }),
      t({ ministry: 'A' }),
      t({ ministry: 'A' }),
    ];
    const f = buildFacets(data);
    expect(f.ministries).toEqual(['A', 'Z']);
    expect(f.agencies).toEqual(['AGENSI A']);
    expect(f.sources).toEqual(['myprocurement']);
    expect(f.procurementTypes).toEqual(['quotation', 'tender']);
  });
});

describe('findById', () => {
  it('returns the tender plus other-source records sharing its dedupKey', () => {
    const a = t({ dedupKey: 'SAME' });
    const b = t({ id: 'other:9', source: 'other', dedupKey: 'SAME' });
    const res = findById([a, b], a.id);
    expect(res?.tender.id).toBe(a.id);
    expect(res?.alsoAvailableFrom.map((x) => x.id)).toEqual(['other:9']);
  });
  it('returns null for unknown id', () => {
    expect(findById([t()], 'nope:1')).toBeNull();
  });
});
