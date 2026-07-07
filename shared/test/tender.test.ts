import { describe, expect, it } from 'vitest';
import { TenderSchema, computeDedupKey, type Tender } from '../src/tender.js';

export function makeTender(overrides: Partial<Tender> = {}): Tender {
  return {
    id: 'myprocurement:789195',
    source: 'myprocurement',
    sourceId: '789195',
    referenceNo: 'UTHM/54(KTKEM)/P/02/023/2026(1)',
    dedupKey: 'UTHM/54(KTKEM)/P/02/023/2026(1)',
    title: 'MENYELENGGARA PERALATAN MAKMAL',
    sourceUrl: 'https://myprocurement.treasury.gov.my/advertisements/quotation/71ebb6ee',
    status: 'open',
    procurementType: 'quotation',
    ministry: 'KEMENTERIAN PENDIDIKAN TINGGI',
    agency: 'UNIVERSITI TUN HUSSEIN ONN MALAYSIA (UTHM)',
    category: 'Perkhidmatan Bukan Perunding',
    fieldCodes: ['060501'],
    advertisedDate: '2026-07-07',
    closingDate: '2026-07-17',
    indicativePrice: 28800,
    currency: 'MYR',
    events: [],
    raw: {},
    scrapedAt: '2026-07-07T12:00:00.000Z',
    ...overrides,
  };
}

describe('TenderSchema', () => {
  it('accepts a fully valid tender', () => {
    expect(TenderSchema.parse(makeTender())).toEqual(makeTender());
  });

  it('accepts nullable fields as null', () => {
    const t = makeTender({
      ministry: null, agency: null, category: null,
      advertisedDate: null, closingDate: null, indicativePrice: null,
    });
    expect(TenderSchema.parse(t)).toEqual(t);
  });

  it('rejects empty id/title and bad enums', () => {
    expect(TenderSchema.safeParse(makeTender({ id: '' })).success).toBe(false);
    expect(TenderSchema.safeParse(makeTender({ title: '' })).success).toBe(false);
    expect(TenderSchema.safeParse({ ...makeTender(), status: 'pending' }).success).toBe(false);
    expect(TenderSchema.safeParse({ ...makeTender(), procurementType: 'rfp' }).success).toBe(false);
    expect(TenderSchema.safeParse({ ...makeTender(), currency: 'USD' }).success).toBe(false);
  });

  it('accepts events with nullable date/address', () => {
    const t = makeTender({
      events: [{ label: 'Lawatan Tapak', date: '2026-07-10', address: 'MAKMAL OR, BLOK A' }],
    });
    expect(TenderSchema.parse(t).events).toHaveLength(1);
  });
});

describe('computeDedupKey', () => {
  it('uppercases and strips all whitespace', () => {
    expect(computeDedupKey('uthm/54 (ktkem) /p/02', 'x')).toBe('UTHM/54(KTKEM)/P/02');
  });
  it('falls back to id when referenceNo is empty or whitespace-only', () => {
    expect(computeDedupKey('', 'myprocurement:1')).toBe('myprocurement:1');
    expect(computeDedupKey('   ', 'myprocurement:1')).toBe('myprocurement:1');
  });
});
