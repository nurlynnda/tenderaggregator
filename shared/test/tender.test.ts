import { describe, expect, it } from 'vitest';
import { TenderPatchSchema, TenderSchema, WinnerSchema, computeDedupKey, type Tender, type TenderPatch } from '../src/tender.js';

export function makeTender(overrides: Partial<Tender> = {}): Tender {
  return {
    dedupKey: 'UTHM/54(KTKEM)/P/02/023/2026(1)',
    referenceNo: 'UTHM/54(KTKEM)/P/02/023/2026(1)',
    title: 'MENYELENGGARA PERALATAN MAKMAL',
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
    winners: null,
    raw: {},
    scrapedAt: '2026-07-07T12:00:00.000Z',
    sources: [{ source: 'myprocurement', sourceId: '789195', sourceUrl: 'https://myprocurement.treasury.gov.my/advertisements/quotation/71ebb6ee' }],
    ...overrides,
  };
}

export function makePatch(overrides: Partial<TenderPatch> = {}): TenderPatch {
  return {
    dedupKey: 'REF/1',
    referenceNo: 'REF/1',
    title: 'T1',
    status: 'open',
    procurementType: 'quotation',
    scrapedAt: '2026-07-07T00:00:00.000Z',
    source: { source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1' },
    ...overrides,
  };
}

describe('WinnerSchema', () => {
  it('accepts a name with a nullable price', () => {
    expect(WinnerSchema.parse({ name: 'EVERLASTING LUCK SDN. BHD.', price: 72000 })).toEqual({
      name: 'EVERLASTING LUCK SDN. BHD.', price: 72000,
    });
    expect(WinnerSchema.safeParse({ name: 'X', price: null }).success).toBe(true);
  });
  it('rejects an empty name', () => {
    expect(WinnerSchema.safeParse({ name: '', price: null }).success).toBe(false);
  });
});

describe('TenderSchema', () => {
  it('accepts a fully valid merged tender', () => {
    expect(TenderSchema.parse(makeTender())).toEqual(makeTender());
  });

  it('accepts nullable fields as null, including winners', () => {
    const t = makeTender({
      ministry: null, agency: null, category: null,
      advertisedDate: null, closingDate: null, indicativePrice: null, winners: null,
    });
    expect(TenderSchema.parse(t)).toEqual(t);
  });

  it('accepts a populated winners array', () => {
    const t = makeTender({ winners: [{ name: 'A SDN BHD', price: 1000 }, { name: 'B SDN BHD', price: null }] });
    expect(TenderSchema.parse(t).winners).toHaveLength(2);
  });

  it('requires at least one entry in sources', () => {
    expect(TenderSchema.safeParse(makeTender({ sources: [] })).success).toBe(false);
  });

  it('rejects empty dedupKey/title and bad enums', () => {
    expect(TenderSchema.safeParse(makeTender({ dedupKey: '' })).success).toBe(false);
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

  it('accepts procurementType: null (source could not classify the tender type)', () => {
    const t = makeTender({ procurementType: null });
    expect(TenderSchema.parse(t)).toEqual(t);
  });
});

describe('TenderPatchSchema', () => {
  it('accepts a minimal identity-only patch (e.g. a results-only enrichment)', () => {
    const patch = makePatch({ winners: [{ name: 'X', price: 1 }] });
    expect(TenderPatchSchema.parse(patch)).toEqual(patch);
  });
  it('accepts a fully populated patch', () => {
    const patch = makePatch({
      ministry: 'M', agency: 'A', category: 'C', fieldCodes: ['010101'],
      advertisedDate: '2026-01-01', closingDate: '2026-01-15', indicativePrice: 500,
      events: [], winners: undefined, raw: { x: 'y' },
    });
    expect(TenderPatchSchema.parse(patch).fieldCodes).toEqual(['010101']);
  });
  it('rejects a patch missing required identity fields', () => {
    const { title: _title, ...withoutTitle } = makePatch();
    expect(TenderPatchSchema.safeParse(withoutTitle).success).toBe(false);
  });

  it('accepts procurementType: null (source could not classify the tender type)', () => {
    const patch = makePatch({ procurementType: null });
    expect(TenderPatchSchema.parse(patch)).toEqual(patch);
  });
});

describe('computeDedupKey', () => {
  it('uppercases and strips all whitespace', () => {
    expect(computeDedupKey('uthm/54 (ktkem) /p/02', 'myprocurement:1')).toBe('UTHM/54(KTKEM)/P/02');
  });
  it('falls back to the given fallback when referenceNo is empty or whitespace-only', () => {
    expect(computeDedupKey('', 'myprocurement:1')).toBe('myprocurement:1');
    expect(computeDedupKey('   ', 'myprocurement:1')).toBe('myprocurement:1');
  });
});
