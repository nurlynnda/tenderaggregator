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

  it('filters by contractor name (case-insensitive substring), matching any winner on the tender', () => {
    const data = [
      t({ winners: [{ name: 'SAFWORKS SDN. BHD.', price: 100 }] }),
      t({ winners: [{ name: 'BBL GLOBAL ENTERPRISE', price: 200 }, { name: 'SAFWORKS SDN. BHD.', price: 50 }] }),
      t({ winners: [{ name: 'SUCEME ENTERPRISE', price: 300 }] }),
      t({ winners: null }),
    ];
    expect(queryTenders(data, { contractor: 'SAFWORKS SDN. BHD.' }).total).toBe(2);
    expect(queryTenders(data, { contractor: 'safworks' }).total).toBe(2); // case-insensitive
    expect(queryTenders(data, { contractor: 'SUCEME' }).total).toBe(1); // partial match
    expect(queryTenders(data, { contractor: 'NOBODY' }).total).toBe(0);
  });

  it('filters by source, matching a tender that has the source among possibly several', () => {
    const data = [
      t({ sources: [{ source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1' }] }),
      t({ sources: [
        { source: 'myprocurement', sourceId: '2', sourceUrl: 'https://example.com/2' },
        { source: 'span', sourceId: '9', sourceUrl: 'https://example.com/9' },
      ] }),
      t({ sources: [{ source: 'kwsp', sourceId: 'Doc1', sourceUrl: 'https://example.com/kwsp/1' }] }),
    ];
    expect(queryTenders(data, { source: 'span' }).total).toBe(1);
    expect(queryTenders(data, { source: 'myprocurement' }).total).toBe(2);
    expect(queryTenders(data, { source: 'kwsp' }).total).toBe(1);
    expect(queryTenders(data, { source: 'nonexistent' }).total).toBe(0);
  });

  it('filters by closingFrom, inclusive, excluding tenders with a null closingDate', () => {
    const data = [
      t({ closingDate: '2026-07-10' }),
      t({ closingDate: '2026-07-15' }),
      t({ closingDate: '2026-07-20' }),
      t({ closingDate: null }),
    ];
    expect(queryTenders(data, { closingFrom: '2026-07-15' }).total).toBe(2);
    expect(queryTenders(data, { closingFrom: '2026-07-10' }).total).toBe(3);
  });

  it('filters by closingTo, inclusive, excluding tenders with a null closingDate', () => {
    const data = [
      t({ closingDate: '2026-07-10' }),
      t({ closingDate: '2026-07-15' }),
      t({ closingDate: '2026-07-20' }),
      t({ closingDate: null }),
    ];
    expect(queryTenders(data, { closingTo: '2026-07-15' }).total).toBe(2);
    expect(queryTenders(data, { closingTo: '2026-07-20' }).total).toBe(3);
  });

  it('filters by closingFrom and closingTo together as an inclusive range', () => {
    const data = [
      t({ closingDate: '2026-07-05' }),
      t({ closingDate: '2026-07-15' }),
      t({ closingDate: '2026-07-25' }),
      t({ closingDate: null }),
    ];
    const page = queryTenders(data, { closingFrom: '2026-07-10', closingTo: '2026-07-20' });
    expect(page.total).toBe(1);
    expect(page.items[0]!.closingDate).toBe('2026-07-15');
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
  it('returns sorted distinct values, omitting nulls, including fieldCodes and sources', () => {
    const data = [
      t({
        ministry: 'Z', agency: null, category: 'Kerja', procurementType: 'tender', fieldCodes: ['220801', '010101'],
        sources: [{ source: 'span', sourceId: '1', sourceUrl: 'https://example.com/1' }],
      }),
      t({ ministry: 'A', fieldCodes: ['010101'] }),
      t({ ministry: 'A' }),
    ];
    const f = buildFacets(data);
    expect(f.ministries).toEqual(['A', 'Z']);
    expect(f.agencies).toEqual(['AGENSI A']);
    expect(f.procurementTypes).toEqual(['quotation', 'tender']);
    expect(f.fieldCodes).toEqual(['010101', '220801']);
    expect(f.sources).toEqual(['myprocurement', 'span']);
  });
});
