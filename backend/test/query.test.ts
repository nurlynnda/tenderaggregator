import { describe, expect, it } from 'vitest';
import type { Tender } from '@tms/shared';
import { buildFacets, queryTenders } from '../src/query/tenders.js';

let seq = 0;
function t(overrides: Partial<Tender> = {}): Tender {
  seq += 1;
  return {
    dedupKey: `REF/${seq}`, referenceNo: `REF/${seq}`, title: `TENDER ${seq}`,
    status: 'open', procurementType: 'quotation',
    ministry: 'KEMENTERIAN A', agency: 'AGENSI A', category: 'Bekalan', fieldCodes: [],
    advertisedDate: '2026-07-01', closingDate: '2026-07-15', indicativePrice: 1000,
    currency: 'MYR', events: [], winners: null, raw: {}, scrapedAt: '2026-07-07T00:00:00.000Z',
    sources: [{ source: 'myprocurement', sourceId: String(seq), sourceUrl: `https://example.com/${seq}` }],
    ...overrides,
  };
}

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
      t({ agency: 'AGENSI B' }),
      t({ category: 'Kerja' }),
      t({ fieldCodes: ['220801'] }),
      t({ winners: [{ name: 'X', price: 1 }] }),
    ];
    expect(queryTenders(data, { ministry: 'KEMENTERIAN B' }).total).toBe(1);
    expect(queryTenders(data, { status: 'closed' }).total).toBe(1);
    expect(queryTenders(data, { procurementType: 'tender' }).total).toBe(1);
    expect(queryTenders(data, { agency: 'AGENSI B' }).total).toBe(1);
    expect(queryTenders(data, { category: 'Kerja' }).total).toBe(1);
    expect(queryTenders(data, { hasWinners: true }).total).toBe(1);
  });

  it('filters by field code prefix at any level', () => {
    const data = [
      t({ fieldCodes: ['220801'] }),
      t({ fieldCodes: ['010101'] }),
      t({ fieldCodes: ['220899'] }),
    ];
    expect(queryTenders(data, { fieldCode: '22' }).total).toBe(2);
    expect(queryTenders(data, { fieldCode: '2208' }).total).toBe(2);
    expect(queryTenders(data, { fieldCode: '220801' }).total).toBe(1);
    expect(queryTenders(data, { fieldCode: '21' }).total).toBe(0);
  });

  it('treats hasWinners as "winners is a non-empty array", not merely non-null', () => {
    const data = [t({ winners: [] }), t({ winners: [{ name: 'X', price: null }] }), t({ winners: null })];
    expect(queryTenders(data, { hasWinners: true }).total).toBe(1);
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

  it('does not mutate the input array while sorting', () => {
    const data = [t({ advertisedDate: '2026-01-01' }), t({ advertisedDate: '2026-06-01' })];
    const copy = [...data];
    queryTenders(data, { sortOrder: 'asc' });
    expect(data).toEqual(copy);
  });
});

describe('buildFacets', () => {
  it('returns sorted distinct values, omitting nulls, including fieldCodes', () => {
    const data = [
      t({ ministry: 'Z', agency: null, category: 'Kerja', procurementType: 'tender', fieldCodes: ['220801', '010101'] }),
      t({ ministry: 'A', fieldCodes: ['010101'] }),
      t({ ministry: 'A' }),
    ];
    const f = buildFacets(data);
    expect(f.ministries).toEqual(['A', 'Z']);
    expect(f.agencies).toEqual(['AGENSI A']);
    expect(f.procurementTypes).toEqual(['quotation', 'tender']);
    expect(f.fieldCodes).toEqual(['010101', '220801']);
  });
});
