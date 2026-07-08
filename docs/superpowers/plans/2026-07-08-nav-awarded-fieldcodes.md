# Navbar, Awarded Tenders, Merged Records & Field-Code Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the tender list into Open/Closed/Awarded nav pages, scrape and display winner data, and replace per-source storage + query-time dedup with a general merge-by-`dedupKey` record model; add a hierarchical field-code filter.

**Architecture:** `Tender` becomes an identity-less merged record (keyed by `dedupKey`, carrying a `sources[]` array and nullable `winners[]`). Adapters emit partial `TenderPatch` objects (not full `Tender`s); `TenderRepository.mergeMany` folds each patch's present fields into the stored record using most-recent-non-null-wins per field, tracked via a parallel field-provenance store. The query layer and API operate on the flat merged array directly (no more `dedupeTenders`). Frontend gains a left nav, three list-page instances of one generalized component, a route keyed by reference number, and a new field-code filter backed by a data file parsed from the MOF PDF.

**Tech Stack:** Same as before — npm workspaces (`shared`/`backend`/`frontend`), TypeScript/ESM, Zod, Express, JSON-file storage, React + Vite + Tailwind + React Query + React Router, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-08-nav-awarded-fieldcodes-design.md` — binding for every task below.
- TDD non-negotiable per `CLAUDE.md`: failing test first, minimal implementation, commit on green, never commit red.
- Tests must never hit the real MyProcurement endpoint — use fixtures/embedded HTML/fakes only.
- 80%/80% line/branch coverage per workspace, enforced by vitest; do not lower thresholds.
- `results-quotation`/`results-tender` are valid archive categories; `results-requisition` is not (confirmed empirically) — no requisition winner data will ever exist, by design, not by special-cased filtering.
- Merge rule: for any field present in a `TenderPatch`, if the patch's `scrapedAt` is newer than that field's last-write provenance, the field is overwritten — **except** a `null` value on a nullable field (`ministry`, `agency`, `category`, `advertisedDate`, `closingDate`, `indicativePrice`, `winners`) is never allowed to overwrite an already-known non-null value, regardless of recency.
- A record's storage key and API-facing identifier is its `dedupKey`; there is no separate `id` field anymore.
- Existing local `backend/data/` (old per-source shape) is dev-only and not migrated — delete it once after this branch lands, so the startup full-rescrape repopulates it under the new shape (already documented in the spec).

---

### Task 1: Shared schema — Winner, TenderSource, merged Tender, TenderPatch

**Files:**
- Modify: `shared/src/tender.ts`
- Modify: `shared/test/tender.test.ts`

**Interfaces:**
- Produces: `WinnerSchema`/`Winner`, `TenderSourceSchema`/`TenderSource`, updated `TenderSchema`/`Tender` (no `id`/`source`/`sourceId`/`sourceUrl`; adds `sources: TenderSource[]`, `winners: Winner[] | null`), `TenderPatchSchema`/`TenderPatch`, updated `computeDedupKey(referenceNo, fallback)`.
- Consumes: nothing (leaf of the dependency graph).

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `shared/test/tender.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w shared`
Expected: FAIL — `TenderPatchSchema`, `WinnerSchema` not exported; `TenderSchema.parse` rejects `sources`/`winners` as unknown-but-required fields; old fixtures in the test reference fields that no longer match current `src/tender.ts`.

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `shared/src/tender.ts`:

```ts
import { z } from 'zod';

export const TenderEventSchema = z.object({
  label: z.string(),
  date: z.string().nullable(),
  address: z.string().nullable(),
});
export type TenderEvent = z.infer<typeof TenderEventSchema>;

export const WinnerSchema = z.object({
  name: z.string().min(1),
  price: z.number().nullable(),
});
export type Winner = z.infer<typeof WinnerSchema>;

export const TenderSourceSchema = z.object({
  source: z.string().min(1),
  sourceId: z.string().min(1),
  sourceUrl: z.string().url(),
});
export type TenderSource = z.infer<typeof TenderSourceSchema>;

export const TenderSchema = z.object({
  dedupKey: z.string().min(1),
  referenceNo: z.string(),
  title: z.string().min(1),
  status: z.enum(['open', 'closed']),
  procurementType: z.enum(['quotation', 'tender', 'requisition']),
  ministry: z.string().nullable(),
  agency: z.string().nullable(),
  category: z.string().nullable(),
  fieldCodes: z.array(z.string()),
  advertisedDate: z.string().nullable(),
  closingDate: z.string().nullable(),
  indicativePrice: z.number().nullable(),
  currency: z.literal('MYR'),
  events: z.array(TenderEventSchema),
  winners: z.array(WinnerSchema).nullable(),
  raw: z.record(z.string()),
  scrapedAt: z.string(),
  sources: z.array(TenderSourceSchema).min(1),
});
export type Tender = z.infer<typeof TenderSchema>;

export function computeDedupKey(referenceNo: string, fallback: string): string {
  const normalized = referenceNo.toUpperCase().replace(/\s+/g, '');
  return normalized.length > 0 ? normalized : fallback;
}

export const TenderPatchSchema = z.object({
  dedupKey: z.string().min(1),
  referenceNo: z.string(),
  title: z.string().min(1),
  status: z.enum(['open', 'closed']),
  procurementType: z.enum(['quotation', 'tender', 'requisition']),
  scrapedAt: z.string(),
  source: TenderSourceSchema,
  ministry: z.string().nullable().optional(),
  agency: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  fieldCodes: z.array(z.string()).optional(),
  advertisedDate: z.string().nullable().optional(),
  closingDate: z.string().nullable().optional(),
  indicativePrice: z.number().nullable().optional(),
  events: z.array(TenderEventSchema).optional(),
  winners: z.array(WinnerSchema).optional(),
  raw: z.record(z.string()).optional(),
});
export type TenderPatch = z.infer<typeof TenderPatchSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w shared`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add shared/src/tender.ts shared/test/tender.test.ts
git commit -m "feat(shared): merged Tender schema with sources[]/winners[], add TenderPatch"
```

---

### Task 2: Field-code data (shared/src/fieldCodes.ts)

**Files:**
- Create: `shared/src/fieldCodes.ts`
- Modify: `shared/src/index.ts`
- Create: `shared/test/fieldCodes.test.ts`

**Interfaces:**
- Produces: `FieldCodeNode` type, `FIELD_CODE_TREE: FieldCodeNode[]`, `flattenFieldCodes(tree?): FlatFieldCode[]`, `fieldCodeMatchesPrefix(tenderCode, filterCode): boolean`.
- Consumes: nothing.

This is a mechanical data-entry task: the full hierarchy below is hand-verified against the source PDF ("Senarai Kod Bidang Bekalan Dan Perkhidmatan - Versi 2.0") and cross-checked against real scraped codes (`220801`, `222501`, `040103`) — transcribe it exactly, do not re-derive it.

- [ ] **Step 1: Write the failing test**

Create `shared/test/fieldCodes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FIELD_CODE_TREE, fieldCodeMatchesPrefix, flattenFieldCodes } from '../src/fieldCodes.js';

describe('FIELD_CODE_TREE', () => {
  it('has exactly 16 top-level categories', () => {
    expect(FIELD_CODE_TREE).toHaveLength(16);
    expect(FIELD_CODE_TREE.map((n) => n.code)).toEqual([
      '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '21', '22',
    ]);
  });

  it('computes full concatenated codes at every level', () => {
    const cat22 = FIELD_CODE_TREE.find((n) => n.code === '22')!;
    expect(cat22.name).toBe('Perkhidmatan');
    const sub08 = cat22.children.find((n) => n.code === '2208')!;
    expect(sub08.name).toBe('Pertahanan Dan Keselamatan');
    const leaf01 = sub08.children.find((n) => n.code === '220801')!;
    expect(leaf01.name).toBe('Kawalan Keselamatan (Perlu lesen KDN)');
  });

  it('matches the PDF changelog cross-check examples (222501, 040103)', () => {
    const flat = flattenFieldCodes();
    expect(flat.find((n) => n.code === '222501')?.name).toBe('Hotel/ Resort (Perlu Sijil Pendaftaran Premis Penginapan bawah Akta Industri Pelancongan 1992 MOTAC dan Lesen PBT)');
    expect(flat.find((n) => n.code === '040103')?.name).toBe('Makanan Bermasak (Islam)');
  });

  it('has no duplicate leaf (6-digit) codes', () => {
    const leafCodes = flattenFieldCodes().filter((n) => n.code.length === 6).map((n) => n.code);
    expect(new Set(leafCodes).size).toBe(leafCodes.length);
    expect(leafCodes.length).toBe(428);
  });
});

describe('flattenFieldCodes', () => {
  it('includes every level (main/sub/leaf) with its full path of names', () => {
    const flat = flattenFieldCodes();
    const leaf = flat.find((n) => n.code === '220801')!;
    expect(leaf.path).toEqual(['Perkhidmatan', 'Pertahanan Dan Keselamatan', 'Kawalan Keselamatan (Perlu lesen KDN)']);
  });
});

describe('fieldCodeMatchesPrefix', () => {
  it('matches a broader category code against a narrower tender code', () => {
    expect(fieldCodeMatchesPrefix('220801', '22')).toBe(true);
    expect(fieldCodeMatchesPrefix('220801', '2208')).toBe(true);
    expect(fieldCodeMatchesPrefix('220801', '220801')).toBe(true);
  });
  it('does not match an unrelated code', () => {
    expect(fieldCodeMatchesPrefix('220801', '21')).toBe(false);
    expect(fieldCodeMatchesPrefix('010101', '22')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w shared`
Expected: FAIL with "Cannot find module '../src/fieldCodes.js'".

- [ ] **Step 3: Write minimal implementation**

Create `shared/src/fieldCodes.ts`:

```ts
export interface FieldCodeNode {
  code: string;
  name: string;
  children: FieldCodeNode[];
}

type RawLeaf = [code: string, name: string];
type RawSub = [code: string, name: string, leaves: RawLeaf[]];
type RawMain = [code: string, name: string, subs: RawSub[]];

function build(mains: RawMain[]): FieldCodeNode[] {
  return mains.map(([mCode, mName, subs]) => ({
    code: mCode,
    name: mName,
    children: subs.map(([sCode, sName, leaves]) => ({
      code: mCode + sCode,
      name: sName,
      children: leaves.map(([lCode, lName]) => ({
        code: mCode + sCode + lCode,
        name: lName,
        children: [],
      })),
    })),
  }));
}

const RAW: RawMain[] = [
  ['01', 'Penerbitan Dan Penyiaran', [
    ['01', 'Penerbitan', [
      ['01', 'Bahan Bacaan Terbitan Luar Negara'],
      ['02', 'Bahan Bacaan'],
      ['03', 'Penerbitan Elektronik Atas Talian'],
      ['04', 'Bahan Penerbitan Elektronik Dan Muzik/ Lagu (Siap Cetak)'],
    ]],
    ['02', 'Kertas', [
      ['01', 'Kertas'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Peralatan Penerbitan/ Percetakan', [
      ['01', 'Peralatan Percetakan Serta Aksesori'],
      ['02', 'Peralatan Sistem Bunyi, Pembesar Suara Dan Projektor'],
      ['03', 'Peralatan/ Perkakasan Penyuntingan/ Persembahan'],
      ['04', 'Medium Penyimpanan'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Papan Tanda Dan Aksesori', [
      ['01', 'Papan Tanda Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['05', 'Fotografi Dan Filem', [
      ['01', 'Kamera Dan Aksesori'],
      ['02', 'Peralatan Pemprosesan Fotografi, Mikrofilem'],
      ['03', 'Filem Dan Mikrofilem'],
      ['04', 'Filem Siap Untuk Tayangan (Lesen B FINAS - Pengedar)'],
      ['99', 'Pembuat'],
    ]],
    ['06', 'Peralatan Pendidikan Dan Latihan', [
      ['01', 'Kit Pendidikan'],
      ['02', 'Bahan Pendidikan'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['02', 'Perabot, Peralatan Pejabat, Hiasan Dalaman Dan Domestik', [
    ['01', 'Perabot, Kelengkapan Dan Aksesori', [
      ['01', 'Perabot, Perabot Makmal Dan Kelengkapan Berasaskan Kayu/ Rotan/ Fabrik/ Logam/ Plastik (Workstation)'],
      ['02', 'Barangan Hiasan Dalaman Dan Aksesori'],
      ['03', 'Permaidani/ Ambar'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Mesin-mesin Pejabat Dan Aksesori', [
      ['01', 'Mesin-mesin Pejabat Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Perkakas Elektrik Dan Elektronik', [
      ['01', 'Perkakas Elektrik Dan Aksesori'],
      ['02', 'Perkakas Elektronik Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Peralatan Dan Perkakas Domestik', [
      ['01', 'Peralatan Dan Perkakas Domestik (Termasuk Barang-barang Yang Tidak Lekat Di Badan)'],
      ['02', 'Perkakasan Dan Bahan Kebersihan Diri Dan Mandian, Kelengkapan Bilik Air Dan Aksesori'],
      ['03', 'Bahan Pencuci Dan Pembersihan'],
      ['04', 'Solekan Dan Andaman'],
      ['99', 'Pembuat'],
    ]],
    ['05', 'Bahan Pembungkusan/ Bekas', [
      ['01', 'Bahan Pembungkusan/ Bekas/ Kotak/ Palet'],
      ['99', 'Pembuat'],
    ]],
    ['06', 'Bekalan Pejabat Dan Alatulis', [
      ['01', 'Alatulis (Tidak Termasuk Borang Dan Semua Jenis Kertas)'],
      ['02', 'Bahan Surih, Drafting Dan Alat Lukis'],
      ['03', 'Organiser, Dairi, Kalendar, Buku Alamat, Resit, Memo'],
      ['04', 'Tag/ Label/ Tanda Dan Stiker'],
      ['99', 'Pembuat'],
    ]],
    ['07', 'Tekstil', [
      ['01', 'Tekstil'],
      ['99', 'Pembuat'],
    ]],
    ['08', 'Pakaian Dan Kelengkapan', [
      ['01', 'Pakaian'],
      ['02', 'Kelengkapan Pakaian'],
      ['03', 'Bagasi Dan Beg Dari Kulit/ PVC/ Kanvas/ Kain/ Nylon/ Plastik/ Logam/ Dll'],
      ['04', 'Pakaian Keselamatan, Kelengkapan Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['09', 'Bahan Tarpaulin Dan Kanvas', [
      ['01', 'Bahan Tarpaulin Dan Kanvas'],
      ['99', 'Pembuat'],
    ]],
    ['10', 'Aksesori Dan Bekalan Jahitan', [
      ['01', 'Butang Dan Bekalan Jahitan (Kits)'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['03', 'Sukan, Rekreasi Dan Alat Muzik (Peralatan, Bekalan Dan Aksesori Sukan Dan Rekreasi)', [
    ['01', 'Pakaian Sukan Dan Aksesori', [
      ['01', 'Pakaian Sukan Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Cenderamata Dan Hadiah', [
      ['01', 'Cenderamata Dan Hadiah'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Alat Muzik', [
      ['01', 'Alat Muzik Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Peralatan Dan Aksesori Perkhemahan Dan Aktiviti Luar', [
      ['01', 'Peralatan Perkhemahan Dan Aktiviti Luar'],
      ['02', 'Peralatan Memancing'],
      ['03', 'Peralatan Memburu'],
      ['99', 'Pembuat'],
    ]],
    ['05', 'Peralatan Sukan Padang, Gelanggang, Rekreasi, Taman Permainan, Kecergasan Dan Sukan Air', [
      ['01', 'Peralatan Sukan'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['04', 'Makanan, Minuman Dan Bahan Mentah', [
    ['01', 'Makanan, Minuman Dan Bahan Mentah Kering/ Basah', [
      ['01', 'Makanan Dan Bahan Mentah Kering/ Basah'],
      ['02', 'Makanan Dan Minuman (Tin, Botol Dan Bungkus)'],
      ['03', 'Makanan Bermasak (Islam)'],
      ['04', 'Makanan Bermasak (Bukan Islam)'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['05', 'Peralatan Hospital, Perubatan, Ubat-ubatan Dan Farmaseutikal', [
    ['01', 'Peralatan Hospital, Bahan Dan Kelengkapan Perubatan', [
      ['01', 'Peralatan Dan Kelengkapan Hospital'],
      ['02', 'Peralatan Dan Kelengkapan Perubatan'],
      ['03', 'Peralatan Untuk Orang Kurang Upaya Dan Pemulihan'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Ubat Dan Bahan Ubatan', [
      ['01', 'Dadah Berjadual [Perlu Lesen Di Bawah Peraturan-peraturan Kawalan Dadah Dan Kosmetik 1984 dari Kementerian Kesihatan Malaysia (KKM)]'],
      ['02', 'Racun Berjadual (Lesen Akta Racun 1952 dari Pengarah Kesihatan Negeri)'],
      ['03', 'Ubat Tidak Berjadual'],
      ['04', 'Makanan/ Minuman Tambahan (Food Suppliment)'],
      ['99', 'Pembuat [Perlu Lesen Pengilang (Borang 2) Dari KKM]'],
    ]],
    ['03', 'Pekakas, Tekstil dan Pakaian Perubatan Pakai Buang/ Guna Semula', [
      ['01', 'Pekakas Perubatan Pakai Buang'],
      ['02', 'Pakaian/ Tekstil Pakai Buang Kakitangan/ Pesakit'],
      ['03', 'Pakaian/ Tekstil Guna Semula Kakitangan/ Pesakit'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['06', 'Kimia, Bahan Kimia Dan Peralatan Makmal', [
    ['01', 'Kimia', [
      ['01', 'Kimia Makmal'],
      ['02', 'Kimia Industri'],
      ['03', 'Kimia Memproses Air'],
      ['04', 'Kimia Memproses Filem/ Fotografi'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Bahan Biokimia Dan Gas', [
      ['01', 'Bahan Peledak (Belerang, Pelarut Hidrokabon Dan Beroksigen/ Gunpowder)'],
      ['02', 'Bunga Api Dan Mercun'],
      ['03', 'Pencucuh/ Alat Penghasil Nyalaan'],
      ['04', 'Gas (Industri Dan Domestik)'],
      ['05', 'Pewarna/ Pencelup/ Lilin'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Bahan Bakar Dan Pelincir', [
      ['01', 'Bahan Bakar'],
      ['02', 'Bahan Pelincir'],
      ['03', 'Bahan Api Nuklear'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Cat, Anti Kakis Dan Bahan Tambah', [
      ['01', 'Cat'],
      ['02', 'Anti Kakis/ Bahan Tambah'],
      ['99', 'Pembuat'],
    ]],
    ['05', 'Peralatan Makmal', [
      ['01', 'Peralatan Makmal Serta Aksesori'],
      ['02', 'Peralatan Makmal Pengukuran, Pencerapan Dan Sukat'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['07', 'Pertanian, Perhutanan Dan Ternakan', [
    ['01', 'Baja Dan Racun', [
      ['01', 'Baja Dan Nutrien Tumbuhan (Organik/ Bukan Organik)'],
      ['02', 'Racun Serangga/ Perosak, Rumpai/ Tumbuhan'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Tanaman, Ternakan, Baka Tanaman/ Ternakan Dan Sampel (Bahan Yang Telah Diawetkan)', [
      ['01', 'Tanaman/ Baka/ Benih Semaian'],
      ['02', 'Haiwan Ternakan/ Bukan Ternakan Dan Akuatik'],
      ['03', 'Sampel Dan Sampel Awetan Haiwan/ Akuatik/ Serangga/ Tumbuhan'],
    ]],
    ['03', 'Ubat, Makanan Ternakan/ Tumbuhan, Peralatan Dan Aksesori', [
      ['01', 'Ubat Haiwan/ Akuatik'],
      ['02', 'Makanan Haiwan/ Akuatik'],
      ['03', 'Peralatan Dan Kelengkapan Pertanian/ Ternakan/ Akuatik'],
      ['04', 'Hasil Sampingan Dan Sisa Perladangan'],
      ['05', 'Habitat Dan Tempat Kurungan Haiwan'],
      ['06', 'Peralatan Pengawalan Perosak Tanaman'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['08', 'Kejuruteraan Awam, Binaan Dan Kelengkapan Kemudahan Awam', [
    ['01', 'Kelengkapan/ Kemudahan Awam', [
      ['01', 'Kelengkapan/ Kemudahan Awam (Kecuali Kelengkapan Kemudahan Permainan/ Sukan)'],
      ['02', 'Kontena'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['09', 'Bahan Binaan Dan Peralatan Keselamatan Jalan Raya', [
    ['01', 'Bahan Binaan', [
      ['01', 'Bahan Binaan'],
      ['02', 'Paip Dan Kelengkapan'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Peralatan Keselamatan Jalan Raya', [
      ['01', 'Peralatan Keselamatan/ Perabot Jalan Raya'],
      ['99', 'Pembuat Keselamatan/ Perabot Jalan Raya'],
    ]],
  ]],
  ['10', 'Peralatan Sukatan Dan Ukuran', [
    ['01', 'Peralatan Sukatan Dan Ukuran', [
      ['01', 'Semua Peralatan Sukatan/ Ukuran'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['11', 'Pengangkutan, Komponen Dan Aksesori', [
    ['01', 'Kenderaan Bermotor Dan Tidak Bermotor', [
      ['01', 'Basikal'],
      ['02', 'Motosikal'],
      ['03', 'Kereta'],
      ['04', 'Lori'],
      ['05', 'Bas'],
      ['06', 'Kenderaan Kegunaan Khusus'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Jentera Berat', [
      ['01', 'Jentera Berat'],
      ['02', 'Kren'],
      ['03', 'Trailer Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Alat Ganti Dan Aksesori Kenderaan/ Jentera Berat', [
      ['01', 'Alat Ganti/ Aksesori Kenderaan'],
      ['02', 'Alat Ganti/ Aksesori Jentera Berat'],
      ['03', 'Enjin Kenderaan/ Jentera Berat'],
      ['04', 'Peralatan Servis Dan Selenggara'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Kenderaan Ber Rel, Peralatan Dan Alat Ganti', [
      ['01', 'Kenderaan Ber Rel, Peralatan Dan Kereta Kabel'],
      ['02', 'Lokomotif Dan Troli Elektrik'],
      ['03', 'Sistem, Peralatan, Alat Ganti Keretapi Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['05', 'Pesawat Udara, Kapal Terbang, Kapal Angkasa, Satelit, Radar', [
      ['01', 'Pesawat Udara'],
      ['02', 'Helikopter'],
      ['03', 'Alatganti Dan Kelengkapan Pesawat/ Helikopter'],
      ['04', 'Kapal Angkasa Dan Alatganti'],
      ['05', 'Satelit Dan Alatganti'],
      ['06', 'Radar Dan Alatganti'],
      ['07', 'Simulator'],
      ['99', 'Pembuat'],
    ]],
    ['06', 'Bot Dan Kapal', [
      ['01', 'Bot'],
      ['02', 'Kapal Laut/ Kapal Selam'],
      ['03', 'Alat Ganti Dan Kelengkapan Bot/ Kapal/ Kapal Selam'],
      ['04', 'Simulator Bot/ Kapal/ Kapal Selam'],
      ['99', 'Pembuat'],
    ]],
    ['07', 'Peralatan Marin', [
      ['01', 'Peralatan Marin'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['12', 'Pertahanan Dan Keselamatan', [
    ['01', 'Senjata, Peluru, Bahan Letupan Dan Aksesori', [
      ['01', 'Senjata Api'],
      ['02', 'Peluru Dan Bom'],
      ['03', 'Aksesori Senjata Api'],
      ['04', 'Bahan Letupan/ Complete Rounds'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Kelengkapan Sasaran', [
      ['01', 'Kelengkapan Sasaran'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Misil, Roket Dan Sub-Sistem', [
      ['01', 'Peluru Berpandu'],
      ['02', 'Sub Sistem Roket'],
      ['03', 'Pelancar Misil Dan Roket'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Peralatan Keselamatan Dan Penguatkuasaan', [
      ['01', 'Alat Keselamatan, Perlindungan Dan Kawalan Perlindungan Dan Kawalan'],
      ['02', 'Alat Forensik Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['05', 'Pengesanan, Pemantauan Dan Perlindungan', [
      ['01', 'Kunci, Perkakasan Perlindungan Dan Aksesori'],
      ['02', 'Peralatan Pemantauan Dan Pengesanan'],
      ['03', 'Lesen/ Pengenalan Dan Pas Keselamatan Bersalut (Laminated)'],
      ['99', 'Pembuat'],
    ]],
    ['06', 'Perlindungan Kebakaran', [
      ['01', 'Sistem Pencegah Kebakaran'],
      ['02', 'Peralatan Kawalan Api'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['13', 'Peralatan Kejuruteraan Dan Mesin Pengeluaran', [
    ['01', 'Mesin, Kelengkapan Bengkel Dan Mesin Pengeluaran', [
      ['01', 'Mesin Dan Kelengkapan Bengkel'],
      ['02', 'Mesin Dan Kelengkapan Khusus'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Janakuasa Elektrik Dan Peralatan Generator/ Alat Ganti Dan Bateri', [
      ['01', 'Janakuasa, Peralatan/ Alat Ganti/ Aksesori (Secondary)'],
      ['02', 'Mesin Dan Kelengkapan Khusus'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Sistem Kumbahan', [
      ['01', 'Peralatan Sistem Kumbahan Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Peralatan Perindustrian Minyak', [
      ['01', 'Peralatan Perindustrian Huluan'],
      ['02', 'Peralatan Perindustrian Hiliran'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['14', 'Peralatan Kejuruteraan Elektrik Dan Elektronik', [
    ['01', 'Mesin Dan Jentera Penjanaan Dan Pengagihan Tenaga Elektrik Serta Aksesori', [
      ['01', 'Motor Dan Alat Ubah/ Alat Ganti'],
      ['02', 'Enjin, Komponen Enjin Dan Aksesori'],
      ['03', 'Komponen Enjin Pembakaran Dalaman/ Gas Turbine'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Stesen Janakuasa Elektrik Dan Peralatan Generator/ Alat Ganti Dan Bateri', [
      ['01', 'Stesen Janakuasa, Peralatan/ Alat Ganti/ Aksesori (Primary)'],
      ['02', 'Penjana Kuasa'],
      ['03', 'Alat Penyimpan Tenaga Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Kabel, Wayar Elektrik Dan Aksesori', [
      ['01', 'Kabel Elektrik Dan Aksesori'],
      ['02', 'Wayar Elektrik Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Peralatan Untuk Tenaga Atom Dan Nuklear', [
      ['01', 'Reaktor Dan Instrumen Nuklear'],
      ['99', 'Pembuat'],
    ]],
    ['05', 'Sistem, Komponen Elektrik, Elektronik, Lampu Dan Aksesori', [
      ['01', 'Sistem Elektronik'],
      ['02', 'Komponen Dan Aksesori Elektrik/ Elektronik'],
      ['03', 'Lampu, Komponen Lampu Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['21', 'ICT (Information Communication Technology) (Bekalan Dan Perkhidmatan Bagi Sektor Teknologi Maklumat Dan Komunikasi)', [
    ['01', 'Peralatan Dan Kelengkapan Komputer, Perkakasan Dan Komponen', [
      ['01', 'Hardware (Low End Technology) — Supply All Types of Computer Hardware Including PC, Notebook, Printer, Document Scanner, Peripherals And Maintenance'],
      ['02', 'Hardware (High End Technology) — All Types of Server, Mainframe, High End Printers, Storage Area Network Software (SAN, NAS) Including Maintenance'],
      ['03', 'Software — Supply All Computers Software, Operating System, Database, Off-The-Shelf Packages Including Maintenance'],
      ['04', 'Software/ System Development/ Customization and Maintenance Including Data Entry, Data Processing'],
      ['05', 'Telecommunication/ Networking-supply Product, Infrastructure, Services Including Maintenance (LAN/ WAN/ Internet/ Wireless/ Satellite)'],
      ['06', 'Data Management — Provide Services Including Disaster'],
      ['07', 'ICT Security and Firewall, Encryption, PKI, Anti Virus'],
      ['08', 'Multimedia-Products, Services and Maintenance (Video Conferencing, Web Cast, Graphic Design, Animation)'],
      ['09', 'Hardware and Software Leasing/ Renting'],
      ['10', 'Geographic Information System (GIS) and Services'],
      ['11', 'Independent Verification and Validation (IV&V)'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Peralatan Dan Kelengkapan Telekomunikasi', [
      ['01', 'Alat Perhubungan'],
      ['02', 'Sistem Perhubungan/ Telekomunikasi'],
      ['03', 'Aksesori Penghubung Dan Telekomunikasi'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['22', 'Perkhidmatan', [
    ['01', 'Penyelenggaraan Dan Pembaikan Kenderaan', [
      ['01', 'Basikal (Tidak Perlu Lawatan Pengesahan)'],
      ['02', 'Motosikal'],
      ['03', 'Kenderaan Kegunaan Khusus (Seperti Kenderaan Rekreasi)'],
      ['04', 'Kenderaan Bawah 3 Ton'],
      ['05', 'Kenderaan Melebihi 3 Ton'],
      ['06', 'Jentera Berat (Lori Pelarik Tanah, Roller Dan Forklift)'],
      ['07', 'Kerja-Kerja Khusus (Baikpulih Enjin) Dan Sebagainya'],
      ['08', 'Kerja-Kerja Mengetuk dan Mengecat'],
      ['09', 'Alat Hawa Dingin Kenderaan'],
      ['10', 'Membaik Pulih Tempat Duduk/ Kusyen Dan Bumbung'],
      ['11', 'Kerja-Kerja Pembaikan Kenderaan Ber Rel Dan Kereta Kabel'],
      ['12', 'Kerja-Kerja Penyelenggaraan Sistem Kenderaan'],
      ['13', 'Membaik Pulih Tayar (Tidak Perlu Lawatan Pengesahan)'],
      ['14', 'Membaik Pulih Bateri (Tidak Perlu Lawatan Pengesahan)'],
      ['15', 'Kenderaan Pertahanan/ Keselamatan Negara – Motosikal'],
      ['16', 'Kenderaan Pertahanan/ Keselamatan Negara – Kenderaan Kegunaan Khusus'],
      ['17', 'Kenderaan Pertahanan/ Keselamatan Negara – Kenderaan Bawah 3 Ton'],
      ['18', 'Kenderaan Pertahanan/ Keselamatan Negara – Kenderaan Melebihi 3 Ton'],
      ['19', 'Kenderaan Pertahanan/ Keselamatan Negara – Jentera Berat'],
      ['20', 'Kenderaan Pertahanan/ Keselamatan Negara – Kerja-Kerja Khusus (Baikpulih Enjin) Dan Sebagainya'],
      ['21', 'Kenderaan Pertahanan/ Keselamatan Negara – Kerja-kerja Mengetuk dan Mengecat'],
      ['22', 'Kenderaan Pertahanan/ Keselamatan Negara – Alat Hawa Dingin Kenderaan'],
      ['23', 'Kenderaan Pertahanan/ Keselamatan Negara – Membaik Pulih Tempat Duduk/ Kusyen dan Bumbung'],
      ['24', 'Kenderaan Pertahanan/ Keselamatan Negara – Kerja-Kerja Penyelenggaraan Sistem Kenderaan'],
    ]],
    ['02', 'Penyelenggaraan/ Pembaikan Mesin, Perabot Pejabat/ Kediaman', [
      ['01', 'Mesin-Mesin Pejabat/ Kediaman'],
      ['02', 'Perabot Pejabat/ Kediaman'],
      ['03', 'Alat Muzik, Kesenian Dan Aksesori'],
    ]],
    ['03', 'Penyelenggaraan/ Pembaikan Alat Hawa Dingin', [
      ['01', 'Alat Hawa Dingin (Window/ Split/ Berpusat)'],
    ]],
    ['04', 'Penyelenggaraan/ Pembaikan Alat Keselamatan', [
      ['01', 'Alat Kebombaan/ Alat Penyelamat/ Pemadam Api'],
      ['02', 'Peralatan Kawalan Keselamatan'],
      ['03', 'Mesin Pengimbas'],
    ]],
    ['05', 'Penyelenggaraan/ Pembaikan Kejuruteraan Dan Komunikasi', [
      ['01', 'Alat Semboyan/ Perhubungan/ Penyiaran'],
      ['02', 'Kontena/ Tangki'],
      ['03', 'Perkakas/ Sistem Elektrik'],
      ['04', 'Mesin dan Peralatan Woksyop'],
      ['05', 'Mechanisation System'],
      ['06', 'Membaiki Buff Fuel Tank'],
      ['07', 'Pump/ Paip Air Dan Komponen'],
      ['08', 'Baikpulih Barang-Barang Logam'],
      ['09', 'Production Testing, Surface Well Testing and Wire Line Services'],
      ['10', 'Faksimili'],
    ]],
    ['06', 'Penyelenggaraan/ Pembaikan Peralatan/ Kelengkapan Perubatan dan Makmal', [
      ['01', 'Alat Kelengkapan Perubatan/ Makmal'],
      ['02', 'Mesin Dan Peralatan Makmal'],
    ]],
    ['07', 'Penyelenggaraan/ Pembaikan Bot/ Kapal, Helikopter, Simulator Dan Pesawat', [
      ['01', 'Bot/ Kapal/ Barge/ Kapal Selam/ Jet Ski/ Sampan (Limbungan/ Tanpa Limbungan)'],
      ['02', 'Sand Blasting Dan Mengecat Untuk Kapal (Tidak Perlu Lawatan Pengesahan)'],
      ['03', 'Penyelenggaraan Kapal Terbang'],
      ['04', 'Penyelenggaraan Helikopter'],
      ['05', 'Penyelenggaraan Simulator Kapal'],
      ['06', 'Penyelenggaraan Simulator Kapal Terbang'],
      ['07', 'Penyelenggaraan Simulator Helikopter'],
      ['08', 'Pembaikan Kenderaan Yang Tidak Berenjin'],
      ['09', 'Kerja Pembaikan Kapal Angkasa/ Satelit'],
      ['10', 'Alat-Alat Marin (Tidak Termasuk Bot/ Kapal)'],
      ['11', 'Kenderaan Pertahanan/ Keselamatan Negara – Bot/ Kapal/ Barge/ Kapal Selam /Jet Ski (Limbungan/ Tanpa Limbungan)'],
      ['12', 'Kenderaan Pertahanan/ Keselamatan Negara – Sand Blasting Dan Mengecat Untuk Kapal'],
      ['13', 'Kenderaan Pertahanan/ Keselamatan Negara – Penyelenggaraan Kapal Terbang'],
      ['14', 'Kenderaan Pertahanan/ Keselamatan Negara – Penyelenggaraan Helikopter'],
    ]],
    ['08', 'Pertahanan Dan Keselamatan', [
      ['01', 'Kawalan Keselamatan (Perlu lesen KDN)'],
      ['02', 'Penyiasat Persendirian (Perlu lesen KDN)'],
      ['03', 'Penyelenggaraan Dan Pembaikan Senjata'],
      ['04', 'Penyelenggaraan Misil/ Roket Dan Sub Sistem, Pelancar'],
    ]],
    ['09', 'Pengawalan Dan Pengawasan', [
      ['01', 'Kawalan Serangga Perosak, Anti Termite (Perlu Lesen Pengendali Kawalan Makhluk Perosak dari Jabatan Pertanian)'],
      ['02', 'Menangkap/ Menembak Haiwan'],
    ]],
    ['10', 'Khidmat Kebersihan Dan Rawatan', [
      ['01', 'Pembersihan Bangunan Dan Pejabat'],
      ['02', 'Membersih Kawasan'],
      ['03', 'Mengangkat Sampah'],
      ['04', 'Membersih Kenderaan (Perlu Lesen PBT)'],
      ['05', 'Mencuci Kolam Renang'],
      ['06', 'Membersih Pantai/ Sungai/ Terusan/ Empangan/ Tasik'],
      ['07', 'Pelupusan Dan Perawatan Sisa Berbahaya [Perlu Lesen daripada Lembaga Perlesenan Tenaga ATOM (AELB)]'],
      ['08', 'Pelupusan Dan Perawatan Buangan Terjadual (Perlu Lesen daripada Jabatan Alam Sekitar)'],
      ['09', 'Pelupusan dan Rawatan Sisa Radio Aktif dan Nuklear [Perlu Lesen daripada Lembaga Perlesenan Tenaga ATOM (AELB)]'],
      ['10', 'Kolam Kumbahan/ Sisa Perawatan/ Talian Paip/ Sesalur'],
      ['11', 'Pembersihan Tumpahan Minyak'],
    ]],
    ['11', 'Guna Tenaga', [
      ['01', 'Kakitangan Iktisas (Profesional) - Tidak Termasuk Khidmat Perundingan'],
      ['02', 'Kakitangan Separa Iktisas (Semi Profesional) - Tidak Termasuk Khidmat Perundingan'],
      ['03', 'Khidmat Guaman'],
      ['04', 'Tenaga Buruh'],
      ['05', 'Pemungut Hutang/ Penghantar Notis'],
      ['06', 'Stevedor'],
      ['07', 'Telly Clerk'],
      ['08', 'Mengikat Dan Melepas Tali Kapal (Mooring)'],
      ['09', 'Menyelam (Diving Service)'],
      ['10', 'Khidmat Latihan, Tenaga Pengajar dan Moderator/ Negotiator'],
      ['11', 'Salvage Boat/ Kapal'],
      ['12', 'Malim Kapal'],
    ]],
    ['12', 'Khidmat Udara/ Laut/ Darat', [
      ['01', 'Topografi/ LIDAR'],
      ['02', 'Pembajaan/ Pest Control'],
      ['03', 'Cloud Seeding'],
      ['04', 'Hidrografi'],
      ['05', 'Oceanografi'],
      ['06', 'Pemetaan/ Pemetaan Utiliti Bawah Tanah'],
      ['07', 'Geologi'],
    ]],
    ['13', 'Kesenian, Hiburan Dan Pelancongan', [
      ['01', 'Pengeluaran Filem (Perlu Lesen FINAS Borang A - Pengeluar)'],
      ['02', 'Rakaman'],
      ['03', 'Fotografi'],
      ['04', 'Audio Visual'],
      ['05', 'Penyediaan Pentas/ Pameran Pertunjukan, Taman Hiburan Dan Karnival/ Pestaria'],
      ['06', 'Artis Dan Penghibur Profesional'],
      ['07', 'Agen Pengembaraan (Dikhaskan Kepada Syarikat 100% Bumiputera)'],
      ['08', 'Dokumentasi Dan Panduarah'],
      ['09', 'Pemeliharaan Bahan Bahan Sejarah Dan Tempat Bersejarah'],
      ['10', 'Penyimpanan Rekod (Surat Kelulusan Daripada Arkib Negara)'],
      ['11', 'Membaikpulih Bahan Terbitan Dan Manuskrip (Surat Kelulusan Daripada Arkib Negara)'],
    ]],
    ['14', 'Pengindahan', [
      ['01', 'Bangunan/ Hiasan Dalaman (Tidak Termasuk Pelanskapan Dan Seni Taman)'],
      ['02', 'Hiasan Jalan/ Kawasan (Tidak Termasuk Pelanskapan Dan Seni Taman)'],
    ]],
    ['15', 'Penyewaan Dan Pengurusan', [
      ['01', 'Perabot/ Kelengkapan'],
      ['02', 'Mesin dan Peralatan Pejabat'],
      ['03', 'Kenderaan/ Jentera/ Kenderaan Rekreasi'],
      ['04', 'Kapal/ Bot/ Bot Tunda/ Feri/ Bot Malim/ Barge/ Jet Ski/ Kapal Selam'],
      ['05', 'Kapal Terbang/ Helikopter/ Pesawat/ Belon Panas/ Simulator Serta Lain-Lain Kenderaan Udara'],
      ['06', 'Bangunan/ Pejabat/ Stor/ Ruang Niaga/ Rumah Kediaman'],
      ['07', 'Kemudahan Awam/ Sukan'],
      ['08', 'Peralatan/ Kelengkapan Hospital Dan Makmal'],
      ['09', 'Peralatan Keselamatan dan Senjata'],
      ['10', 'Tempat Letak Kereta'],
      ['11', 'P.A Sistem Dan Alat Muzik'],
      ['12', 'Bantuan Kecemasan Dan Ambulans/ Kenderaan Jenazah'],
      ['13', 'Pakaian/ Kelengkapan Dan Aksesori'],
    ]],
    ['16', 'Percetakan', [
      ['01', 'Mencetak Buku, Majalah, Laporan Akhbar (Perlu Lesen KDN)'],
      ['02', 'Mencetak Fail, Kad Perniagaan Dan Kad Ucapan (Perlu Lesen KDN)'],
      ['03', 'Mencetak Label, Poster, Pelekat Dan Iron On (Perlu Lesen KDN)'],
      ['04', 'Mencetak Label, Poster Dan Pelekat (Plastik) (Perlu Lesen KDN)'],
      ['05', 'Mencetak Continuous Stationery Forms (Perlu Lesen KDN)'],
      ['06', 'Mencetak Borang/Kertas Komputer (Perlu Lesen KDN)'],
      ['07', 'Cetakan Keselamatan (Perlu Lesen KDN Dan Surat Kelulusan Pejabat Ketua Pengarah Keselamatan Kerajaan, Jabatan Perdana Menteri) (Dikhaskan Kepada Syarikat 100% Bumiputera)'],
      ['08', 'Cetakan Hologram (Perlu Lesen KDN Dan Surat Kelulusan Pejabat Ketua Pengarah Keselamatan Kerajaan, Jabatan Perdana Menteri) (Dikhaskan Kepada Syarikat 100% Bumiputera)'],
      ['09', 'Pisah Warna (Colour Separation)'],
      ['10', 'Menjilid Kulit Keras'],
      ['11', 'Varnishing'],
      ['12', 'Laminating'],
      ['13', 'Menjilid Kulit Lembut'],
      ['14', 'Pengatur Huruf (Type Setting)'],
      ['15', 'Rekabentuk Percetakan (Printing Design)'],
    ]],
    ['17', 'Perkhidmatan Pengangkutan, Penyimpanan Dan Pos', [
      ['01', 'Pemilik Kapal (Perlu Sijil MCR)'],
      ['02', 'Broker Perkapalan (Perjanjian Daripada Syarikat Perkapalan)'],
      ['03', 'Agen Perkapalan (Perlu Lesen Kastam)'],
      ['04', 'Pengangkutan Lori (Perlu Lesen APAD)'],
      ['05', 'Agen Penghantaran (Perlu Lesen Kastam)'],
      ['06', 'Pembungkusan Dan Penyimpanan (Perlu Gudang Berlesen Kastam Dan Lesen PBT)'],
      ['07', 'Pembungkusan'],
      ['08', 'Penghantaran Dokumen (Perlu Lesen Pos)'],
      ['09', 'Multimodal Transport Operator (MTO)'],
      ['10', 'Perkhidmatan Mel Pukal'],
      ['11', 'Pengurusan Pelabuhan'],
      ['12', 'Ship Chandling'],
      ['13', 'Ship Trimming'],
    ]],
    ['18', 'Perkhidmatan Kewangan Dan Insuran', [
      ['01', 'Syarikat Insuran (Perlu Lesen Bank Negara Malaysia)'],
      ['02', 'Broker Insuran (Perlu Lesen Bank Negara Malaysia)'],
      ['03', 'Penyediaan Akaun Dan Pengauditan'],
      ['04', 'Pengurusan Kewangan Dan Korporat'],
      ['05', 'Pemfaktoran (Dimansuhkan)'],
      ['06', 'Syarikat Pelelong Awam (Perlu Lesen Pelelong PBT)'],
    ]],
    ['19', 'Barang Lusuh', [
      ['01', 'Membeli Barang Lusuh Tanpa Permit'],
      ['02', 'Membeli Barang Lusuh Perlu Permit (Perlu Permit PDRM)'],
    ]],
    ['20', 'Editorial, Rakbentuk Grafik, Seni Halus Dan Harta Intelek', [
      ['01', 'Media Elektronik (Tidak Termasuk Kerja-kerja Percetakan)'],
      ['02', 'Media Cetak (Tidak Termasuk Kerja-kerja Percetakan)'],
      ['03', 'Bill Board'],
      ['04', 'Penulisan — Semua Jenis Penulisan'],
      ['05', 'Mereka-Cipta Dan Seni Halus'],
      ['06', 'Penterjemahan'],
      ['07', 'Pengkomersilan'],
      ['08', 'Hak Harta Intelek (Patent)'],
      ['09', 'Lain-lain Media Media Pengiklanan'],
      ['10', 'Perkhidmatan Fotostat'],
    ]],
    ['21', 'Perkhidmatan Perladangan/ Perikanan/ Haiwan Dan Hidupan Liar', [
      ['01', 'Perikanan Dan Akuakultur'],
      ['02', 'Hortikultur'],
      ['03', 'Ternakan'],
      ['04', 'Pertanian/ Tanaman/ Ladang/ Taman/ Hutan Dan Ladang Hutan'],
      ['05', 'Rawatan Hutan'],
      ['06', 'Sumber Air'],
      ['07', 'Tatahias Haiwan'],
      ['08', 'Tukun Tiruan'],
    ]],
    ['22', 'Perkhidmatan Hal Ehwal Sosial Dan Politik', [
      ['01', 'Hubungan Antarabangsa'],
      ['02', 'Bantuan Kemanusiaan'],
      ['03', 'Dasar Dan Peraturan'],
    ]],
    ['23', 'Perkhidmatan Domestik', [
      ['01', 'Solekan'],
      ['02', 'Dobi'],
      ['03', 'Membekal Air'],
      ['04', 'Pengurusan Jenazah Dan Kelengkapan'],
      ['05', 'Mengangkut Mayat'],
    ]],
    ['24', 'Perkhidmatan Menjahit Dan Baik Pulih', [
      ['01', 'Menjahit Pakaian Dan Kelengkapan'],
      ['02', 'Menjahit Bukan Pakaian'],
      ['03', 'Baik Pulih Kasut Dan Barangan Kulit'],
      ['04', 'Barangan PVC/ Kanvas'],
      ['05', 'Barangan Logam'],
    ]],
    ['25', 'Hotel, Rumah Tumpangan Dan Pusat Latihan', [
      ['01', 'Hotel/ Resort (Perlu Sijil Pendaftaran Premis Penginapan bawah Akta Industri Pelancongan 1992 MOTAC dan Lesen PBT)'],
      ['02', 'Motel/ Chalet/ Rumah Tumpangan (Perlu Lesen PBT)'],
      ['03', 'Homestay (Perlu Kementerian Surat Kementerian Pelancongan)'],
      ['04', 'Pusat Latihan (Perlu Lesen PBT)'],
    ]],
    ['26', 'Perkhidmatan Kejuruteraan Elektrik Dan Elektronik', [
      ['01', 'Akustik Dan Gelombang'],
      ['02', 'Pencahayaan (Illumination)'],
    ]],
    ['27', 'Perkhidmatan Lain-lain', [
      ['01', 'Pengurusan Telekomunikasi'],
      ['02', 'Marker/ DNA'],
      ['03', 'Bioteknologi'],
      ['04', 'Pensijilan Dan Pengiktirafan'],
      ['05', 'Ujian Makmal'],
      ['06', 'Kodifikasi'],
      ['07', 'Perkhidmatan Perubatan - Dialisis'],
    ]],
    ['28', 'Perkidmatan Teknologi Hijau', [
      ['01', 'Teknologi Hijau [Surat/ Sijil Daripada Suruhanjaya Tenaga (Energy Commission) atau Malaysia Green Technology Corporation]'],
    ]],
    ['29', 'Seni Ukir', [
      ['01', 'Ukiran Berasaskan Kayu [Perlu Kemukakan Sijil Pendaftaran Dengan Perbadanan Kemajuan Kraftangan Malaysia (PKKM)]'],
    ]],
  ]],
];

export const FIELD_CODE_TREE: FieldCodeNode[] = build(RAW);

export interface FlatFieldCode {
  code: string;
  name: string;
  path: string[];
}

export function flattenFieldCodes(tree: FieldCodeNode[] = FIELD_CODE_TREE): FlatFieldCode[] {
  const out: FlatFieldCode[] = [];
  const walk = (nodes: FieldCodeNode[], path: string[]) => {
    for (const node of nodes) {
      const nextPath = [...path, node.name];
      out.push({ code: node.code, name: node.name, path: nextPath });
      if (node.children.length > 0) walk(node.children, nextPath);
    }
  };
  walk(tree, []);
  return out;
}

export function fieldCodeMatchesPrefix(tenderCode: string, filterCode: string): boolean {
  return tenderCode.startsWith(filterCode);
}
```

Modify `shared/src/index.ts`:

```ts
export * from './tender.js';
export * from './fieldCodes.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w shared`
Expected: PASS, all tests green (this file has no branching logic beyond `build`/`flattenFieldCodes`'s recursion, which the tests exercise; if line/branch coverage flags the barrel re-export line added to `index.ts`, follow the precedent already established in this repo of excluding pure barrel re-exports from coverage rather than adding dead tests for them — verify the threshold actually fails before doing so, same as before).

- [ ] **Step 5: Commit**

```bash
git add shared/src/fieldCodes.ts shared/src/index.ts shared/test/fieldCodes.test.ts
git commit -m "feat(shared): field-code hierarchy data from the MOF bidang code PDF"
```

---

### Task 3: MyProcurement listing parser emits patches, not full Tenders

**Files:**
- Modify: `backend/src/scrapers/myprocurement/parseListing.ts`
- Modify: `backend/test/parseListing.test.ts`

**Interfaces:**
- Consumes: `TenderPatchSchema`, `computeDedupKey`, `TenderEvent` from `@tms/shared` (Task 1); `parseDdMmYyyy`, `parseRmPrice`, `splitFieldCodes` from `../../parsing/text.js` (unchanged).
- Produces: `parseListingHtml(html, ctx): TenderPatch[]` (was `Tender[]`), `JobContext` (unchanged shape).

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `backend/test/parseListing.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { TenderPatchSchema } from '@tms/shared';
import { parseListingHtml, type JobContext } from '../src/scrapers/myprocurement/parseListing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NOW = () => '2026-07-07T12:00:00.000Z';
const OPEN_Q: JobContext = { status: 'open', procurementType: 'quotation', now: NOW };

// Single card verbatim from the real API response shape (entities included), with an
// events table, so exact values can be asserted deterministically.
const CARD_HTML = `<div>
  <div x-data="{ selected: false, open: true }" class="flex flex-col">
    <div class="flex">
      <button x-on:click="selected = !selected; $dispatch('select-procurement', { id: 789195 })"></button>
    </div>
    <div class="flex-grow text-sm md:text-base break-words">
      <div>
        <div class="mx-4 px-4 py-2 inline-block rounded-md bg-primary/20">
          Tarikh Pelawaan: 07/07/2026
        </div>
        <div class="px-4 py-2 rounded-md">
          <span class="font-bold">No. Sebut Harga</span>: UTHM/54(KTKEM)/P/02/023/2026(1)
        </div>
        <div class="px-4 py-2 rounded-md text-justify font-bold text-primary uppercase">
          <a href="https://myprocurement.treasury.gov.my/advertisements/quotation/71ebb6ee">MAKMAL ELEKTRIK &amp; ELEKTRONIK 2</a>
        </div>
        <div x-show="open" class="flex flex-col w-full px-4">
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Kementerian:</div>
            <div class="w-full sm:w-2/3 uppercase">KEMENTERIAN PENDIDIKAN TINGGI</div>
          </div>
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Agensi:</div>
            <div class="w-full sm:w-2/3 uppercase">UNIVERSITI TUN HUSSEIN ONN MALAYSIA (UTHM)</div>
          </div>
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Kategori Perolehan:</div>
            <div class="w-full sm:w-2/3 uppercase">Perkhidmatan Bukan Perunding</div>
          </div>
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Kod Bidang:</div>
            <div class="w-full sm:w-2/3 uppercase">E05, E32</div>
          </div>
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Tarikh Tutup Pelawaan:</div>
            <div class="w-full sm:w-2/3 uppercase">17/07/2026</div>
          </div>
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Harga Indikatif Jabatan:</div>
            <div class="w-full sm:w-2/3 uppercase">RM 28,800.00</div>
          </div>
        </div>
        <div x-show="open" class="mt-2 w-full">
          <table class="w-full hidden md:block">
            <tr class="bg-primary/20"><th>Bil.</th><th>Perkara</th><th>Tarikh</th><th>Alamat</th></tr>
            <tr class="uppercase">
              <td>1.</td>
              <td>Lawatan Tapak</td>
              <td>10/07/2026</td>
              <td class="w-full">MAKMAL OR, BLOK A, STRIDE, KAJANG, SELANGOR</td>
            </tr>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>`;

describe('parseListingHtml — embedded card, exact values', () => {
  it('extracts every field from a card, shaped as a TenderPatch', () => {
    const [t] = parseListingHtml(CARD_HTML, OPEN_Q);
    expect(t).toBeDefined();
    expect(t!.source).toEqual({
      source: 'myprocurement', sourceId: '789195',
      sourceUrl: 'https://myprocurement.treasury.gov.my/advertisements/quotation/71ebb6ee',
    });
    expect(t!.referenceNo).toBe('UTHM/54(KTKEM)/P/02/023/2026(1)');
    expect(t!.dedupKey).toBe('UTHM/54(KTKEM)/P/02/023/2026(1)');
    expect(t!.title).toBe('MAKMAL ELEKTRIK & ELEKTRONIK 2'); // entity decoded
    expect(t!.status).toBe('open');
    expect(t!.procurementType).toBe('quotation');
    expect(t!.ministry).toBe('KEMENTERIAN PENDIDIKAN TINGGI');
    expect(t!.agency).toBe('UNIVERSITI TUN HUSSEIN ONN MALAYSIA (UTHM)');
    expect(t!.category).toBe('Perkhidmatan Bukan Perunding');
    expect(t!.fieldCodes).toEqual(['E05', 'E32']);
    expect(t!.advertisedDate).toBe('2026-07-07');
    expect(t!.closingDate).toBe('2026-07-17');
    expect(t!.indicativePrice).toBe(28800);
    expect(t!.events).toEqual([
      { label: 'Lawatan Tapak', date: '2026-07-10', address: 'MAKMAL OR, BLOK A, STRIDE, KAJANG, SELANGOR' },
    ]);
    expect(t!.raw!['No. Sebut Harga']).toBe('UTHM/54(KTKEM)/P/02/023/2026(1)');
    expect(t!.raw!['Harga Indikatif Jabatan']).toBe('RM 28,800.00');
    expect(t!.scrapedAt).toBe('2026-07-07T12:00:00.000Z');
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('tags status/procurementType from the job context, not page text', () => {
    const [t] = parseListingHtml(CARD_HTML, { status: 'closed', procurementType: 'tender', now: NOW });
    expect(t!.status).toBe('closed');
    expect(t!.procurementType).toBe('tender');
  });

  it('skips cards without a title link instead of throwing', () => {
    const broken = CARD_HTML.replace(/<a href="[^"]*">.*?<\/a>/s, '');
    expect(parseListingHtml(broken, OPEN_Q)).toEqual([]);
  });
});

describe('parseListingHtml — edge cases for branch coverage', () => {
  it('skips a card whose title link has an invalid sourceUrl instead of throwing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badUrl = CARD_HTML.replace(
      'href="https://myprocurement.treasury.gov.my/advertisements/quotation/71ebb6ee"',
      'href="/relative/not-a-full-url"',
    );
    expect(parseListingHtml(badUrl, OPEN_Q)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[myprocurement] skipping invalid card'));
    warnSpy.mockRestore();
  });

  it('ignores non-card x-data wrappers (e.g. pagination controls)', () => {
    const withPagination = `<div x-data="{ page: 1 }"><span>1</span></div>${CARD_HTML}`;
    const [t] = parseListingHtml(withPagination, OPEN_Q);
    expect(t!.source.sourceId).toBe('789195');
  });

  it('falls back to Date.now() when ctx.now is not provided', () => {
    const [t] = parseListingHtml(CARD_HTML, { status: 'open', procurementType: 'quotation' });
    expect(typeof t!.scrapedAt).toBe('string');
    expect(t!.scrapedAt.length).toBeGreaterThan(0);
  });

  it('defaults missing address to null when the address cell is empty', () => {
    const noAddress = CARD_HTML.replace(
      '<td class="w-full">MAKMAL OR, BLOK A, STRIDE, KAJANG, SELANGOR</td>',
      '<td class="w-full"></td>',
    );
    const [t] = parseListingHtml(noAddress, OPEN_Q);
    expect(t!.events![0]!.address).toBeNull();
  });

  it('falls back to the source:sourceId composite for dedupKey when referenceNo is empty', () => {
    const noRef = CARD_HTML.replace(
      '<span class="font-bold">No. Sebut Harga</span>: UTHM/54(KTKEM)/P/02/023/2026(1)',
      '<span class="font-bold">No. Sebut Harga</span>: ',
    );
    const [t] = parseListingHtml(noRef, OPEN_Q);
    expect(t!.referenceNo).toBe('');
    expect(t!.dedupKey).toBe('myprocurement:789195');
  });
});

const FIXTURES: Array<{ file: string; ctx: JobContext }> = [
  { file: 'open-quotation-p1.json', ctx: { status: 'open', procurementType: 'quotation', now: NOW } },
  { file: 'open-tender-p1.json', ctx: { status: 'open', procurementType: 'tender', now: NOW } },
  { file: 'open-requisition-p1.json', ctx: { status: 'open', procurementType: 'requisition', now: NOW } },
  { file: 'archive-quotation-p1.json', ctx: { status: 'closed', procurementType: 'quotation', now: NOW } },
];

describe('parseListingHtml — live fixtures, structural invariants', () => {
  for (const { file, ctx } of FIXTURES) {
    it(`parses every card in ${file} into schema-valid patches`, () => {
      const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', file), 'utf8'));
      const patches = parseListingHtml(raw.html, ctx);
      expect(patches.length).toBeGreaterThan(0);
      // Every select-procurement id in the HTML must yield a parsed patch: nothing missed.
      const idsInHtml = new Set([...raw.html.matchAll(/select-procurement'?,?\s*\{\s*id:\s*(\d+)/g)].map((m) => m[1]));
      expect(new Set(patches.map((t) => t.source.sourceId))).toEqual(idsInHtml);
      for (const t of patches) {
        expect(() => TenderPatchSchema.parse(t)).not.toThrow();
        expect(t.status).toBe(ctx.status);
        expect(t.procurementType).toBe(ctx.procurementType);
        if (t.advertisedDate) expect(t.advertisedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if (t.closingDate) expect(t.closingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend -- parseListing`
Expected: FAIL — current `parseListingHtml` returns full `Tender` shape (`id`/`source: string`/`sourceUrl` top-level), not `{ source: TenderSource, ... }` patches; `TenderPatchSchema` isn't imported yet at all in the old file.

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `backend/src/scrapers/myprocurement/parseListing.ts`:

```ts
import * as cheerio from 'cheerio';
import type { AnyNode, Cheerio } from 'cheerio';
import { TenderPatchSchema, computeDedupKey, type TenderPatch, type TenderEvent } from '@tms/shared';
import { parseDdMmYyyy, parseRmPrice, splitFieldCodes } from '../../parsing/text.js';

export interface JobContext {
  status: 'open' | 'closed';
  procurementType: 'quotation' | 'tender' | 'requisition';
  now?: () => string;
}

const SOURCE = 'myprocurement';

export function parseListingHtml(html: string, ctx: JobContext): TenderPatch[] {
  const $ = cheerio.load(html);
  const now = ctx.now ?? (() => new Date().toISOString());
  const patches: TenderPatch[] = [];

  $('div[x-data]').each((_, el) => {
    const card = $(el);
    const xData = card.attr('x-data') ?? '';
    if (!xData.includes('selected')) return; // pagination wrapper etc.

    const candidate = parseCard($, card, ctx, now());
    if (!candidate) return;
    const result = TenderPatchSchema.safeParse(candidate);
    if (!result.success) {
      console.warn(`[myprocurement] skipping invalid card: ${result.error.message}`);
      return;
    }
    patches.push(result.data);
  });

  return patches;
}

function parseCard(
  $: cheerio.CheerioAPI,
  card: Cheerio<AnyNode>,
  ctx: JobContext,
  scrapedAt: string,
): Record<string, unknown> | null {
  const idMatch = card.html()?.match(/select-procurement'?,?\s*\{\s*id:\s*(\d+)/);
  if (!idMatch) return null;
  const sourceId = idMatch[1]!;

  const link = card.find('div.font-bold.text-primary a').first();
  const title = clean(link.text());
  const sourceUrl = link.attr('href') ?? '';
  if (!title || !sourceUrl) return null;

  const raw: Record<string, string> = {};

  // Label/value detail rows: <div class="... font-bold align-top">Label:</div><div>Value</div>
  card.find('div.font-bold.align-top').each((_, labelEl) => {
    const label = clean($(labelEl).text()).replace(/:$/, '');
    const value = clean($(labelEl).next('div').text());
    if (label) raw[label] = value;
  });

  // Reference number row: <span class="font-bold">No. Sebut Harga</span>: VALUE
  let referenceNo = '';
  card.find('span.font-bold').each((_, spanEl) => {
    const span = $(spanEl);
    const label = clean(span.text());
    if (!label.startsWith('No.')) return;
    const parentText = clean(span.parent().text());
    referenceNo = clean(parentText.slice(parentText.indexOf(label) + label.length).replace(/^:/, ''));
    raw[label] = referenceNo;
  });

  // Advertised date badge: "Tarikh Pelawaan: 07/07/2026"
  const badgeMatch = card.text().match(/Tarikh Pelawaan:\s*([\d/]+)/);
  if (badgeMatch) raw['Tarikh Pelawaan'] = badgeMatch[1]!;

  // Events from the desktop table: Bil. | Perkara | Tarikh | Alamat
  const events: TenderEvent[] = [];
  card.find('table tr').each((_, rowEl) => {
    const cells = $(rowEl).find('td');
    if (cells.length < 4) return;
    events.push({
      label: clean(cells.eq(1).text()),
      date: parseDdMmYyyy(clean(cells.eq(2).text())),
      address: clean(cells.eq(3).text()) || null,
    });
  });

  const fallback = `${SOURCE}:${sourceId}`;
  return {
    dedupKey: computeDedupKey(referenceNo, fallback),
    referenceNo,
    title,
    status: ctx.status,
    procurementType: ctx.procurementType,
    scrapedAt,
    source: { source: SOURCE, sourceId, sourceUrl },
    ministry: raw['Kementerian'] || null,
    agency: raw['Agensi'] || null,
    category: raw['Kategori Perolehan'] || null,
    fieldCodes: splitFieldCodes(raw['Kod Bidang']),
    advertisedDate: parseDdMmYyyy(raw['Tarikh Pelawaan']),
    closingDate: parseDdMmYyyy(raw['Tarikh Tutup Pelawaan']),
    indicativePrice: parseRmPrice(raw['Harga Indikatif Jabatan']),
    events,
    raw,
  };
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w backend -- parseListing`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrapers/myprocurement/parseListing.ts backend/test/parseListing.test.ts
git commit -m "refactor(backend): parseListingHtml emits TenderPatch, not full Tender"
```

---

### Task 4: Results-page parser (winner enrichment patches)

**Files:**
- Create: `backend/src/scrapers/myprocurement/parseResults.ts`
- Create: `backend/test/parseResults.test.ts`
- Create: `backend/test/fixtures/results-quotation-p1.json`

**Interfaces:**
- Consumes: `TenderPatchSchema`, `computeDedupKey`, `Winner` from `@tms/shared`; `parseRmPrice` from `../../parsing/text.js`.
- Produces: `parseResultsHtml(html, ctx): TenderPatch[]`, `ResultsJobContext = { procurementType: 'quotation' | 'tender'; now?: () => string }`.

Winner-table structure and the `No. Sebut Harga`/`No. Tender` label, `Kementerian`/`Agensi`/`Kategori Perolehan` presence, and absence of `Kod Bidang`/`Tarikh Tutup Pelawaan`/`Harga Indikatif Jabatan` are all confirmed via the live curl investigation recorded in the design spec.

- [ ] **Step 1: Create the real-capture fixture**

Create `backend/test/fixtures/results-quotation-p1.json` (a genuine single-card capture from `type=archive&category=results-quotation`, page 1 — real reference number, title, ministry, agency, and winner):

```json
{
  "html": "<div>\n            <div x-data=\"{ selected: false, open: true }\" \n        x-on:clear-selection.window=\"selected = false\"\n        class=\"flex flex-col sm:flex-row gap-4 p-4 mt-4 shadow-md bg-background border-2 rounded-xl border-gray-200\">\n        <div class=\"flex\">\n            <button x-on:click=\"selected = !selected; $dispatch('select-procurement', { id: 980576 })\"\n                x-on:select-all.window=\"selected = true; $dispatch('select-procurement', { id: 980576, all: true })\"\n                x-bind:class=\"selected ? 'bg-primary' : 'bg-white'\"\n                class=\"relative w-6 h-6 aspect-square rounded-md border-2 border-gray-200 hover:border-blue-300 duration-100 transition-colors\">\n                <i  x-show=\"selected\" \n                    class=\"absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 fa-solid fa-check text-white\"></i>\n            </button>\n            <button class=\"flex-grow flex justify-end md:hidden\" x-on:click=\"open = !open\" type=\"button\">\n                <i class=\"fa-solid fa-chevron-down\" x-show=\"open\"></i>\n                <i class=\"fa-solid fa-chevron-up\" x-show=\"!open\"></i>\n            </button>\n        </div>\n                                                                    <div class=\"flex-grow text-sm md:text-base break-words\">\n    <div class=\"mx-4 px-4 py-2 inline-block rounded-md bg-primary/20\">\n        Tarikh Paparan Keputusan: 01/07/2026\n    </div>\n    \n    <div class=\"px-4 py-2 rounded-md\">\n                <span class=\"font-bold\">No. Sebut Harga</span>: 52000003\n         \n    </div>\n    <div class=\"px-4 py-2 rounded-md font-bold text-primary uppercase\">\n                    <a href=\"https://myprocurement.treasury.gov.my/archive/results-quotation/f256becbbb44e73ed436120b9b0ab381\">PERKHIDMATAN SEWAAN 45 UNIT RUMAH KELUARGA DI TAMAN SEJATI UNTUK KEGUNAAN RASMI KD SRI TAWAU DAN PL TSR BULAN MAC 26</a>\n            </div>\n    <div x-show=\"open\" class=\"w-full flex flex-col px-4\">\n        <div class=\"flex flex-col sm:flex-row mt-2\">\n            <div class=\"w-full sm:w-1/3 font-bold align-top\">Kementerian:</div>\n            <div class=\"w-full sm:w-2/3 uppercase\">KEMENTERIAN PERTAHANAN</div>\n        </div>\n        <div class=\"flex flex-col sm:flex-row mt-2\">\n            <div class=\"w-full sm:w-1/3 font-bold align-top\">Agensi:</div>\n            <div class=\"w-full sm:w-2/3 uppercase\">TENTERA LAUT DIRAJA MALAYSIA (TLDM)</div>\n        </div>\n        <div class=\"flex flex-col sm:flex-row mt-2\">\n            <div class=\"w-full sm:w-1/3 font-bold align-top\">Kategori Perolehan:</div>\n            <div class=\"w-full sm:w-2/3 uppercase\">Perkhidmatan Bukan Perunding</div>\n        </div>\n        <div class=\"flex flex-col sm:flex-row mt-2\">\n            <div class=\"w-full sm:w-1/3 font-bold align-top\">Tarikh Keputusan:</div>\n            <div class=\"w-full sm:w-2/3 uppercase\">Tiada Maklumat</div>\n        </div>\n    </div>\n    <div x-show=\"open\" class=\"mt-4\">\n                    <div class=\"flex sm:hidden p-4 gap-4 rounded-md border border-blue-500/50\">\n                <div class=\"flex justify-between font-bold\">\n                    <div>\n                        1.\n                    </div>\n                </div>\n                <div class=\"flex flex-col gap-2\">\n                    <div>\n                        <h3 class=\"uppercase font-bold\">Nama Petender Berjaya</h3>\n                        EVERLASTING LUCK SDN. BHD.\n                    </div>\n                    <div>\n                        <h3 class=\"uppercase font-bold\">Harga Setuju Terima (RM)</h3>\n                        72,000.00\n                    </div>\n                </div>\n            </div>\n                <table class=\"hidden sm:block w-full\">\n            <tr class=\"bg-primary/20\">\n                <th class=\"text-start px-4 py-2 border border-primary/30\">\n                    Bil.\n                </th>\n                <th class=\"text-start px-4 py-2 border border-primary/30\">\n                    Nama Petender Berjaya\n                </th>\n                <th class=\"text-start px-4 py-2 border border-primary/30 text-nowrap\">\n                    Harga Setuju Terima (RM)\n                </th>\n            </tr>\n                            <tr>\n                    <td class=\"text-start px-4 py-2 border border-primary/30\">\n                        1.\n                    </td>\n                    <td class=\"text-start px-4 py-2 border border-primary/30 w-full\">\n                        EVERLASTING LUCK SDN. BHD.\n                    </td>\n                    <td class=\"text-end px-4 py-2 border border-primary/30\">\n                        72,000.00\n                    </td>\n                </tr>\n                    </table>\n    </div>\n</div>                                        </div>",
  "total": 117463,
  "page": 1,
  "lastPage": 11747
}
```

- [ ] **Step 2: Write the failing test**

Create `backend/test/parseResults.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TenderPatchSchema } from '@tms/shared';
import { parseResultsHtml, type ResultsJobContext } from '../src/scrapers/myprocurement/parseResults.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = () => '2026-07-08T00:00:00.000Z';
const QUOTATION: ResultsJobContext = { procurementType: 'quotation', now: NOW };

// Real card captured from type=archive&category=results-quotation (single winner).
const SINGLE_WINNER_CARD = `<div x-data="{ selected: false, open: true }">
  <button x-on:click="$dispatch('select-procurement', { id: 980576 })"></button>
  <div class="mx-4 px-4 py-2 inline-block rounded-md bg-primary/20">Tarikh Paparan Keputusan: 01/07/2026</div>
  <div class="px-4 py-2 rounded-md"><span class="font-bold">No. Sebut Harga</span>: 52000003</div>
  <div class="font-bold text-primary uppercase">
    <a href="https://myprocurement.treasury.gov.my/archive/results-quotation/f256becbbb44e73ed436120b9b0ab381">PERKHIDMATAN SEWAAN 45 UNIT RUMAH KELUARGA</a>
  </div>
  <div class="w-full flex flex-col px-4">
    <div class="font-bold align-top">Kementerian:</div><div>KEMENTERIAN PERTAHANAN</div>
    <div class="font-bold align-top">Agensi:</div><div>TENTERA LAUT DIRAJA MALAYSIA (TLDM)</div>
    <div class="font-bold align-top">Kategori Perolehan:</div><div>Perkhidmatan Bukan Perunding</div>
  </div>
  <table>
    <tr><th>Bil.</th><th>Nama Petender Berjaya</th><th>Harga Setuju Terima (RM)</th></tr>
    <tr><td>1.</td><td>EVERLASTING LUCK SDN. BHD.</td><td>72,000.00</td></tr>
  </table>
</div>`;

// Real multi-lot winner table captured from a second results-quotation card, attached here
// to the same real card shell above to test multi-winner parsing deterministically.
const MULTI_WINNER_CARD = SINGLE_WINNER_CARD.replace(
  '<tr><td>1.</td><td>EVERLASTING LUCK SDN. BHD.</td><td>72,000.00</td></tr>',
  `<tr><td>1.</td><td>DOUBLE R ENTERPRISE</td><td>15,000.00</td></tr>
   <tr><td>2.</td><td>IMPIAN BENTARA</td><td>429,782.20</td></tr>`,
);

describe('parseResultsHtml — embedded card, exact values', () => {
  it('extracts identity fields, ministry/agency/category, and a single winner', () => {
    const [t] = parseResultsHtml(SINGLE_WINNER_CARD, QUOTATION);
    expect(t).toBeDefined();
    expect(t!.source).toEqual({
      source: 'myprocurement', sourceId: '980576',
      sourceUrl: 'https://myprocurement.treasury.gov.my/archive/results-quotation/f256becbbb44e73ed436120b9b0ab381',
    });
    expect(t!.referenceNo).toBe('52000003');
    expect(t!.dedupKey).toBe('52000003');
    expect(t!.status).toBe('closed');
    expect(t!.procurementType).toBe('quotation');
    expect(t!.ministry).toBe('KEMENTERIAN PERTAHANAN');
    expect(t!.agency).toBe('TENTERA LAUT DIRAJA MALAYSIA (TLDM)');
    expect(t!.category).toBe('Perkhidmatan Bukan Perunding');
    expect(t!.winners).toEqual([{ name: 'EVERLASTING LUCK SDN. BHD.', price: 72000 }]);
    // Fields this job never observes must be absent from the patch, not present-as-null/empty.
    expect(t!.fieldCodes).toBeUndefined();
    expect(t!.closingDate).toBeUndefined();
    expect(t!.indicativePrice).toBeUndefined();
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('parses multiple winners for a multi-lot award', () => {
    const [t] = parseResultsHtml(MULTI_WINNER_CARD, QUOTATION);
    expect(t!.winners).toEqual([
      { name: 'DOUBLE R ENTERPRISE', price: 15000 },
      { name: 'IMPIAN BENTARA', price: 429782.2 },
    ]);
  });

  it('tags procurementType from the job context (tender vs quotation)', () => {
    const [t] = parseResultsHtml(SINGLE_WINNER_CARD, { procurementType: 'tender', now: NOW });
    expect(t!.procurementType).toBe('tender');
  });

  it('skips cards without a title link instead of throwing', () => {
    const broken = SINGLE_WINNER_CARD.replace(/<a href="[^"]*">.*?<\/a>/s, '');
    expect(parseResultsHtml(broken, QUOTATION)).toEqual([]);
  });
});

describe('parseResultsHtml — live fixture, structural invariants', () => {
  it('parses every card in results-quotation-p1.json into schema-valid patches', () => {
    const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'results-quotation-p1.json'), 'utf8'));
    const patches = parseResultsHtml(raw.html, QUOTATION);
    expect(patches.length).toBeGreaterThan(0);
    const idsInHtml = new Set([...raw.html.matchAll(/select-procurement'?,?\s*\{\s*id:\s*(\d+)/g)].map((m: RegExpMatchArray) => m[1]));
    expect(new Set(patches.map((t) => t.source.sourceId))).toEqual(idsInHtml);
    for (const t of patches) {
      expect(() => TenderPatchSchema.parse(t)).not.toThrow();
      expect(t.status).toBe('closed');
      expect(t.winners!.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w backend -- parseResults`
Expected: FAIL with "Cannot find module '../src/scrapers/myprocurement/parseResults.js'".

- [ ] **Step 4: Write minimal implementation**

Create `backend/src/scrapers/myprocurement/parseResults.ts`:

```ts
import * as cheerio from 'cheerio';
import type { AnyNode, Cheerio } from 'cheerio';
import { TenderPatchSchema, computeDedupKey, type TenderPatch, type Winner } from '@tms/shared';
import { parseRmPrice } from '../../parsing/text.js';

export interface ResultsJobContext {
  procurementType: 'quotation' | 'tender';
  now?: () => string;
}

const SOURCE = 'myprocurement';

export function parseResultsHtml(html: string, ctx: ResultsJobContext): TenderPatch[] {
  const $ = cheerio.load(html);
  const now = ctx.now ?? (() => new Date().toISOString());
  const patches: TenderPatch[] = [];

  $('div[x-data]').each((_, el) => {
    const card = $(el);
    const xData = card.attr('x-data') ?? '';
    if (!xData.includes('selected')) return;

    const candidate = parseResultsCard($, card, ctx, now());
    if (!candidate) return;
    const result = TenderPatchSchema.safeParse(candidate);
    if (!result.success) {
      console.warn(`[myprocurement] skipping invalid results card: ${result.error.message}`);
      return;
    }
    patches.push(result.data);
  });

  return patches;
}

function parseResultsCard(
  $: cheerio.CheerioAPI,
  card: Cheerio<AnyNode>,
  ctx: ResultsJobContext,
  scrapedAt: string,
): Record<string, unknown> | null {
  const idMatch = card.html()?.match(/select-procurement'?,?\s*\{\s*id:\s*(\d+)/);
  if (!idMatch) return null;
  const sourceId = idMatch[1]!;

  const link = card.find('div.font-bold.text-primary a').first();
  const title = clean(link.text());
  const sourceUrl = link.attr('href') ?? '';
  if (!title || !sourceUrl) return null;

  const raw: Record<string, string> = {};
  card.find('div.font-bold.align-top').each((_, labelEl) => {
    const label = clean($(labelEl).text()).replace(/:$/, '');
    const value = clean($(labelEl).next('div').text());
    if (label) raw[label] = value;
  });

  let referenceNo = '';
  card.find('span.font-bold').each((_, spanEl) => {
    const span = $(spanEl);
    const label = clean(span.text());
    if (!label.startsWith('No.')) return;
    const parentText = clean(span.parent().text());
    referenceNo = clean(parentText.slice(parentText.indexOf(label) + label.length).replace(/^:/, ''));
    raw[label] = referenceNo;
  });

  // Winner rows: the desktop table's header row has <th> cells (0 <td>s), so filtering on
  // "at least 3 <td> cells" naturally skips the header without separate detection logic.
  const winners: Winner[] = [];
  card.find('table tr').each((_, rowEl) => {
    const cells = $(rowEl).find('td');
    if (cells.length < 3) return;
    const name = clean(cells.eq(1).text());
    if (!name) return;
    winners.push({ name, price: parseRmPrice(clean(cells.eq(2).text())) });
  });

  const fallback = `${SOURCE}:${sourceId}`;
  return {
    dedupKey: computeDedupKey(referenceNo, fallback),
    referenceNo,
    title,
    status: 'closed' as const,
    procurementType: ctx.procurementType,
    scrapedAt,
    source: { source: SOURCE, sourceId, sourceUrl },
    ministry: raw['Kementerian'] || null,
    agency: raw['Agensi'] || null,
    category: raw['Kategori Perolehan'] || null,
    winners,
    raw,
  };
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w backend -- parseResults`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/scrapers/myprocurement/parseResults.ts backend/test/parseResults.test.ts backend/test/fixtures/results-quotation-p1.json
git commit -m "feat(backend): parse winner data from MyProcurement results-* archive pages"
```

---

### Task 5: Adapter wires the 2 results jobs alongside the existing 6

**Files:**
- Modify: `backend/src/scrapers/myprocurement/adapter.ts`
- Modify: `backend/test/adapter.test.ts`

**Interfaces:**
- Consumes: `parseListingHtml` (Task 3), `parseResultsHtml` (Task 4), `ScrapeHooks`/`ScrapeScope`/`ScraperAdapter` from `../types.js` (Task 7 changes `ScrapeHooks.onBatch`'s parameter type from `Tender[]` to `TenderPatch[]`).
- Produces: `MYPROCUREMENT_JOBS` with 8 entries (6 `kind: 'full'` + 2 `kind: 'results'`).

**Dependency note:** this task's `adapter.scrape` now produces `TenderPatch[]` batches instead of `Tender[]`. `ScrapeHooks.onBatch`'s parameter type must already be `TenderPatch[]` (Task 7, below) for this to typecheck cleanly — **execute Tasks 6 and 7 before this task** even though it's numbered before them in this document (neither has a dependency on this task, so reordering execution is safe; this task is placed here in the document only because it reads naturally right after the parsers it wires together).

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `backend/test/adapter.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { TenderPatch } from '@tms/shared';
import { MyProcurementAdapter, MYPROCUREMENT_JOBS } from '../src/scrapers/myprocurement/adapter.js';

// Minimal parseable card generator (same markup shape both parsers understand: identity +
// reference number + title link; no winner table, so results jobs yield winners: []).
function cardHtml(id: number, ref: string): string {
  return `<div x-data="{ selected: false, open: true }">
    <button x-on:click="$dispatch('select-procurement', { id: ${id} })"></button>
    <div class="px-4 py-2"><span class="font-bold">No. Sebut Harga</span>: ${ref}</div>
    <div class="font-bold text-primary"><a href="https://myprocurement.treasury.gov.my/advertisements/quotation/h${id}">TITLE ${id}</a></div>
  </div>`;
}

function pageResponse(ids: number[], lastPage: number) {
  return { html: `<div>${ids.map((i) => cardHtml(i, `REF/${i}`)).join('')}</div>`, total: ids.length, page: 1, lastPage };
}

describe('MYPROCUREMENT_JOBS', () => {
  it('defines exactly the 8 verified type/category combinations (6 full + 2 results)', () => {
    expect(MYPROCUREMENT_JOBS).toEqual([
      { status: 'open', procurementType: 'quotation', type: 'advertisements', category: 'quotation', kind: 'full' },
      { status: 'open', procurementType: 'tender', type: 'advertisements', category: 'tender', kind: 'full' },
      { status: 'open', procurementType: 'requisition', type: 'advertisements', category: 'requisition', kind: 'full' },
      { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'advertisement-quotation', kind: 'full' },
      { status: 'closed', procurementType: 'tender', type: 'archive', category: 'advertisement-tender', kind: 'full' },
      { status: 'closed', procurementType: 'requisition', type: 'archive', category: 'advertisement-requisition', kind: 'full' },
      { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'results-quotation', kind: 'results' },
      { status: 'closed', procurementType: 'tender', type: 'archive', category: 'results-tender', kind: 'results' },
    ]);
  });
});

describe('MyProcurementAdapter', () => {
  it('scope=open crawls only the 3 advertisement jobs, every page, with explicit params', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      return pageResponse([page * 10 + 1], 2); // 2 pages per job
    });
    const adapter = new MyProcurementAdapter(fetcher);
    const batches: TenderPatch[][] = [];
    await adapter.scrape('open', { onProgress: () => {}, onBatch: async (t) => { batches.push(t); } });

    expect(urls).toHaveLength(6); // 3 jobs x 2 pages
    for (const url of urls) {
      const params = new URL(url).searchParams;
      expect(params.get('itemsPerPage')).toBe('100');
      expect(params.get('type')).toBe('advertisements');
      expect(['quotation', 'tender', 'requisition']).toContain(params.get('category'));
    }
    expect(batches).toHaveLength(6);
    expect(batches.flat().every((t) => t.status === 'open')).toBe(true);
  });

  it('scope=archive crawls the 3 archive jobs plus the 2 results jobs (5 total)', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { urls.push(url); return pageResponse([1], 1); });
    const adapter = new MyProcurementAdapter(fetcher);
    await adapter.scrape('archive', { onProgress: () => {}, onBatch: async () => {} });
    expect(urls).toHaveLength(5);
    for (const url of urls) {
      const params = new URL(url).searchParams;
      expect(params.get('type')).toBe('archive');
      expect(params.get('category')).toMatch(/^(advertisement-(quotation|tender|requisition)|results-(quotation|tender))$/);
    }
  });

  it('scope=all runs all 8 jobs and tags status/procurementType per job', async () => {
    const fetcher = vi.fn(async (url: string) => pageResponse([Number(new URL(url).searchParams.get('page'))], 1));
    const adapter = new MyProcurementAdapter(fetcher);
    const all: TenderPatch[] = [];
    await adapter.scrape('all', { onProgress: () => {}, onBatch: async (t) => { all.push(...t); } });
    expect(all.filter((t) => t.status === 'open')).toHaveLength(3);
    expect(all.filter((t) => t.status === 'closed')).toHaveLength(5);
  });

  it('emits winners (possibly empty) only for results jobs, via parseResultsHtml', async () => {
    const fetcher = vi.fn(async () => pageResponse([1], 1));
    const adapter = new MyProcurementAdapter(fetcher);
    const batchesByJob: TenderPatch[][] = [];
    await adapter.scrape('archive', { onProgress: () => {}, onBatch: async (t) => { batchesByJob.push(t); } });
    // Jobs run in MYPROCUREMENT_JOBS order filtered to closed: 3 full archive jobs, then 2 results jobs.
    const resultsBatches = batchesByJob.slice(3);
    expect(resultsBatches).toHaveLength(2);
    for (const batch of resultsBatches) {
      for (const patch of batch) {
        expect(patch.winners).toEqual([]); // no winner table in this fixture's card markup
        expect(patch.fieldCodes).toBeUndefined(); // results patches never observe field codes
      }
    }
  });

  it('reports progress with job name, page counts and job totals', async () => {
    const fetcher = vi.fn(async () => pageResponse([1], 2));
    const adapter = new MyProcurementAdapter(fetcher);
    const progress: unknown[] = [];
    await adapter.scrape('archive', { onProgress: (p) => progress.push({ ...p }), onBatch: async () => {} });
    expect(progress[0]).toEqual({
      source: 'myprocurement', job: 'closed-quotation',
      jobsCompleted: 0, jobsTotal: 5, currentPage: 1, lastPage: 2,
    });
  });

  it('names results jobs distinctly (job name suffix)', async () => {
    const fetcher = vi.fn(async () => pageResponse([1], 1));
    const adapter = new MyProcurementAdapter(fetcher);
    const jobNames: string[] = [];
    await adapter.scrape('archive', { onProgress: (p) => jobNames.push(p.job), onBatch: async () => {} });
    expect(jobNames).toEqual([
      'closed-quotation', 'closed-tender', 'closed-requisition',
      'closed-quotation-results', 'closed-tender-results',
    ]);
  });

  it('rejects when the fetcher exhausts retries, without calling onBatch for the failed page', async () => {
    const fetcher = vi.fn(async () => { throw new Error('fetch failed after 3 attempts: x'); });
    const adapter = new MyProcurementAdapter(fetcher);
    const onBatch = vi.fn(async () => {});
    await expect(adapter.scrape('open', { onProgress: () => {}, onBatch })).rejects.toThrow('fetch failed');
    expect(onBatch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend -- adapter`
Expected: FAIL — `MYPROCUREMENT_JOBS` still has 6 entries without `kind`; scope='archive' still yields 3 urls, not 5.

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `backend/src/scrapers/myprocurement/adapter.ts`:

```ts
import { z } from 'zod';
import type { ScrapeHooks, ScrapeScope, ScraperAdapter } from '../types.js';
import { parseListingHtml } from './parseListing.js';
import { parseResultsHtml } from './parseResults.js';

const BASE_URL = 'https://myprocurement.treasury.gov.my/procurements/fetch';
const ITEMS_PER_PAGE = 100;

export const MYPROCUREMENT_JOBS = [
  { status: 'open', procurementType: 'quotation', type: 'advertisements', category: 'quotation', kind: 'full' },
  { status: 'open', procurementType: 'tender', type: 'advertisements', category: 'tender', kind: 'full' },
  { status: 'open', procurementType: 'requisition', type: 'advertisements', category: 'requisition', kind: 'full' },
  { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'advertisement-quotation', kind: 'full' },
  { status: 'closed', procurementType: 'tender', type: 'archive', category: 'advertisement-tender', kind: 'full' },
  { status: 'closed', procurementType: 'requisition', type: 'archive', category: 'advertisement-requisition', kind: 'full' },
  { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'results-quotation', kind: 'results' },
  { status: 'closed', procurementType: 'tender', type: 'archive', category: 'results-tender', kind: 'results' },
] as const;

const ListingResponse = z.object({ html: z.string(), lastPage: z.number().int().min(1) });

export class MyProcurementAdapter implements ScraperAdapter {
  readonly name = 'myprocurement';

  constructor(private readonly fetcher: (url: string) => Promise<unknown>) {}

  async scrape(scope: ScrapeScope, hooks: ScrapeHooks): Promise<void> {
    const jobs = MYPROCUREMENT_JOBS.filter((j) =>
      scope === 'all' ? true : scope === 'open' ? j.status === 'open' : j.status === 'closed',
    );

    for (const [jobIndex, job] of jobs.entries()) {
      const jobName = job.kind === 'results'
        ? `${job.status}-${job.procurementType}-results`
        : `${job.status}-${job.procurementType}`;
      let page = 1;
      let lastPage = 1;
      do {
        const url = `${BASE_URL}?page=${page}&itemsPerPage=${ITEMS_PER_PAGE}&type=${job.type}&category=${job.category}`;
        const body = ListingResponse.parse(await this.fetcher(url));
        lastPage = body.lastPage;
        hooks.onProgress({
          source: this.name,
          job: jobName,
          jobsCompleted: jobIndex,
          jobsTotal: jobs.length,
          currentPage: page,
          lastPage,
        });
        const patches = job.kind === 'results'
          ? parseResultsHtml(body.html, { procurementType: job.procurementType })
          : parseListingHtml(body.html, { status: job.status, procurementType: job.procurementType });
        await hooks.onBatch(patches);
        page += 1;
      } while (page <= lastPage);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w backend -- adapter`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrapers/myprocurement/adapter.ts backend/test/adapter.test.ts
git commit -m "feat(backend): add results-quotation/results-tender jobs to the adapter"
```

---

### Task 6: TenderRepository — merge-by-dedupKey storage

**Files:**
- Modify: `backend/src/storage/repository.ts`
- Modify: `backend/test/repository.test.ts`

**Interfaces:**
- Consumes: `Tender`, `TenderPatch` from `@tms/shared` (Task 1).
- Produces: `TenderRepository` with `load()`, `getAll(): Tender[]`, `hasSource(source): boolean`, `getSourceCount(source): number`, `mergeMany(patches: TenderPatch[]): void`, `findByDedupKey(key): Tender | null`, `flush(): Promise<void>` (no argument — was `flush(source)`), `getMeta(source)`, `setMeta(source, patch)` (both unchanged). `dedupeTenders`/`getDeduped` are removed entirely (storage is deduped by construction now).

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `backend/test/repository.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend -- repository`
Expected: FAIL — `mergeMany`/`findByDedupKey`/`getSourceCount` don't exist yet; `flush()` still requires a `source` argument; `upsertMany`/`getDeduped` are gone from the test but still present in the old implementation, causing a type/behavior mismatch.

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `backend/src/storage/repository.ts`:

```ts
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tender, TenderPatch } from '@tms/shared';

export interface SourceMeta {
  lastScrapedAt: string | null;
  lastArchiveBackfillAt: string | null;
  total: number;
}

const DEFAULT_META: SourceMeta = { lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 };

// Fields that may legitimately be scraped as null; a later patch's null must never clobber
// an already-known value for these (see design: "most-recent-non-null-wins"). Array fields
// (fieldCodes, events) and always-present identity fields don't need this guard: they never
// carry null, only omission (absent key) or an empty array, both handled by the generic loop.
const NULLABLE_FIELDS = new Set([
  'ministry', 'agency', 'category', 'advertisedDate', 'closingDate', 'indicativePrice', 'winners',
]);

type ProvenanceMap = Record<string, string>; // fieldName -> scrapedAt ISO of the patch that last wrote it

export class TenderRepository {
  private readonly merged = new Map<string, Tender>(); // dedupKey -> Tender
  private readonly provenance = new Map<string, ProvenanceMap>(); // dedupKey -> field provenance
  private readonly metaBySource = new Map<string, SourceMeta>();

  constructor(private readonly dataDir: string) {}

  async load(): Promise<void> {
    try {
      const tenders = JSON.parse(await readFile(join(this.dataDir, 'tenders.json'), 'utf8')) as Tender[];
      for (const t of tenders) this.merged.set(t.dedupKey, t);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    try {
      const prov = JSON.parse(
        await readFile(join(this.dataDir, 'field-provenance.json'), 'utf8'),
      ) as Record<string, ProvenanceMap>;
      for (const [key, value] of Object.entries(prov)) this.provenance.set(key, value);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }

    let sourceDirs: string[] = [];
    try {
      sourceDirs = (await readdir(this.dataDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return; // data dir doesn't exist yet
    }
    for (const source of sourceDirs) {
      try {
        const meta = JSON.parse(await readFile(join(this.dataDir, source, 'meta.json'), 'utf8')) as SourceMeta;
        this.metaBySource.set(source, { ...DEFAULT_META, ...meta });
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
    }
  }

  getAll(): Tender[] {
    return [...this.merged.values()];
  }

  findByDedupKey(dedupKey: string): Tender | null {
    return this.merged.get(dedupKey) ?? null;
  }

  hasSource(source: string): boolean {
    return this.metaBySource.has(source);
  }

  getSourceCount(source: string): number {
    let count = 0;
    for (const t of this.merged.values()) {
      if (t.sources.some((s) => s.source === source)) count += 1;
    }
    return count;
  }

  mergeMany(patches: TenderPatch[]): void {
    for (const patch of patches) this.mergeOne(patch);
  }

  private mergeOne(patch: TenderPatch): void {
    const key = patch.dedupKey;
    const existing = this.merged.get(key);

    if (!existing) {
      const seeded: Tender = {
        dedupKey: key,
        referenceNo: patch.referenceNo,
        title: patch.title,
        status: patch.status,
        procurementType: patch.procurementType,
        ministry: patch.ministry ?? null,
        agency: patch.agency ?? null,
        category: patch.category ?? null,
        fieldCodes: patch.fieldCodes ?? [],
        advertisedDate: patch.advertisedDate ?? null,
        closingDate: patch.closingDate ?? null,
        indicativePrice: patch.indicativePrice ?? null,
        currency: 'MYR',
        events: patch.events ?? [],
        winners: patch.winners ?? null,
        raw: patch.raw ?? {},
        scrapedAt: patch.scrapedAt,
        sources: [patch.source],
      };
      const prov: ProvenanceMap = {};
      for (const field of Object.keys(patch)) {
        if (field === 'dedupKey' || field === 'source') continue;
        prov[field] = patch.scrapedAt;
      }
      this.merged.set(key, seeded);
      this.provenance.set(key, prov);
      return;
    }

    const prov = this.provenance.get(key) ?? {};
    this.provenance.set(key, prov);
    const mutable = existing as unknown as Record<string, unknown>;

    for (const [field, value] of Object.entries(patch)) {
      if (field === 'dedupKey' || field === 'source') continue;
      if (value === undefined) continue; // this job didn't observe this field

      if (value === null && NULLABLE_FIELDS.has(field) && mutable[field] != null) {
        continue; // never let "no information" clobber a known value
      }

      const lastWrite = prov[field];
      if (lastWrite !== undefined && patch.scrapedAt < lastWrite) continue; // stale/out-of-order patch

      mutable[field] = value;
      prov[field] = patch.scrapedAt;
    }

    const srcIdx = existing.sources.findIndex((s) => s.source === patch.source.source);
    if (srcIdx === -1) existing.sources.push(patch.source);
    else existing.sources[srcIdx] = patch.source;
  }

  async flush(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await atomicWrite(join(this.dataDir, 'tenders.json'), JSON.stringify([...this.merged.values()]));
    await atomicWrite(
      join(this.dataDir, 'field-provenance.json'),
      JSON.stringify(Object.fromEntries(this.provenance)),
    );
  }

  getMeta(source: string): SourceMeta {
    return this.metaBySource.get(source) ?? { ...DEFAULT_META };
  }

  async setMeta(source: string, patch: Partial<SourceMeta>): Promise<void> {
    const merged = { ...this.getMeta(source), ...patch };
    this.metaBySource.set(source, merged);
    const dir = join(this.dataDir, source);
    await mkdir(dir, { recursive: true });
    await atomicWrite(join(dir, 'meta.json'), JSON.stringify(merged, null, 2));
  }
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}
```

Note the behavior change from before: `hasSource(source)` now reflects "this adapter has completed at least one `setMeta` call" (i.e. `data/<source>/meta.json` exists), rather than "a per-source `tenders.json` file existed" — there is no longer a per-source tenders file to check, since tender data is a single shared merged store. This preserves the intent `index.ts`'s startup policy relies on (has this adapter ever finished a scrape) with the new storage shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w backend -- repository`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/storage/repository.ts backend/test/repository.test.ts
git commit -m "refactor(backend): TenderRepository merges patches by dedupKey, replacing per-source storage + query-time dedup"
```

---

### Task 7: Scraper types + ScrapeManager use TenderPatch and mergeMany

**Files:**
- Modify: `backend/src/scrapers/types.ts`
- Modify: `backend/src/scrape/manager.ts`
- Modify: `backend/test/manager.test.ts`

**Interfaces:**
- Consumes: `TenderPatch` from `@tms/shared` (Task 1); `TenderRepository.mergeMany`/`flush()`/`getSourceCount`/`getMeta`/`setMeta` (Task 6).
- Produces: `ScrapeHooks.onBatch: (patches: TenderPatch[]) => Promise<void>` (was `Tender[]`); `ScrapeManager` unchanged public surface (`status()`, `start(scope)`, `runToCompletion(scope)`), now calling `repo.mergeMany`/`repo.flush()` (no source arg) and stamping `total` via `repo.getSourceCount(adapter.name)`.

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `backend/test/manager.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TenderPatch } from '@tms/shared';
import type { ScrapeHooks, ScrapeScope, ScraperAdapter } from '../src/scrapers/types.js';
import { TenderRepository } from '../src/storage/repository.js';
import { ScrapeManager } from '../src/scrape/manager.js';

const NOW = () => '2026-07-07T12:00:00.000Z';

function makePatch(id: number): TenderPatch {
  return {
    dedupKey: `REF/${id}`, referenceNo: `REF/${id}`, title: `T${id}`,
    status: 'open', procurementType: 'quotation',
    scrapedAt: NOW(),
    source: { source: 'fake', sourceId: String(id), sourceUrl: `https://example.com/${id}` },
  };
}

function fakeAdapter(behavior: (scope: ScrapeScope, hooks: ScrapeHooks) => Promise<void>): ScraperAdapter {
  return { name: 'fake', scrape: behavior };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function freshRepo() {
  const repo = new TenderRepository(mkdtempSync(join(tmpdir(), 'tms-mgr-')));
  await repo.load();
  return repo;
}

describe('ScrapeManager', () => {
  it('starts idle', async () => {
    const mgr = new ScrapeManager([], await freshRepo(), { now: NOW });
    expect(mgr.status()).toEqual({ state: 'idle' });
  });

  it('runs a scrape: merges batches, reports done, stamps lastScrapedAt and total', async () => {
    const repo = await freshRepo();
    const adapter = fakeAdapter(async (_scope, hooks) => {
      hooks.onProgress({ source: 'fake', job: 'open-quotation', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1 });
      await hooks.onBatch([makePatch(1), makePatch(2)]);
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('open');
    expect(mgr.status().state).toBe('done');
    expect(repo.getAll()).toHaveLength(2);
    expect(repo.getMeta('fake').lastScrapedAt).toBe(NOW());
    expect(repo.getMeta('fake').lastArchiveBackfillAt).toBeNull();
    expect(repo.getMeta('fake').total).toBe(2);
  });

  it('stamps lastArchiveBackfillAt when scope covers archive', async () => {
    const repo = await freshRepo();
    const adapter = fakeAdapter(async () => {});
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('all');
    expect(repo.getMeta('fake').lastArchiveBackfillAt).toBe(NOW());
  });

  it('exposes live progress while running', async () => {
    const repo = await freshRepo();
    let capturedMid: unknown;
    const adapter = fakeAdapter(async (_s, hooks) => {
      hooks.onProgress({ source: 'fake', job: 'open-tender', jobsCompleted: 1, jobsTotal: 3, currentPage: 12, lastPage: 96 });
      capturedMid = mgr.status();
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('open');
    expect(capturedMid).toEqual({
      state: 'running', source: 'fake', job: 'open-tender',
      jobsCompleted: 1, jobsTotal: 3, currentPage: 12, lastPage: 96,
    });
  });

  it('rejects concurrent starts', async () => {
    const repo = await freshRepo();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const adapter = fakeAdapter(async () => gate);
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    expect(mgr.start('open')).toBe(true);
    expect(mgr.start('open')).toBe(false); // already running
    release();
    await waitUntil(() => mgr.status().state !== 'running');
    expect(mgr.status().state).toBe('done');
  });

  it('defaults to a small flush interval for open scope and a larger one for archive/all scope', async () => {
    async function countFlushes(scope: ScrapeScope, pages: number): Promise<number> {
      const repo = await freshRepo();
      const originalFlush = repo.flush.bind(repo);
      let flushCount = 0;
      repo.flush = async () => {
        flushCount += 1;
        return originalFlush();
      };
      const adapter = fakeAdapter(async (_s, hooks) => {
        for (let i = 0; i < pages; i += 1) {
          await hooks.onBatch([makePatch(i)]);
        }
      });
      const mgr = new ScrapeManager([adapter], repo, { now: NOW });
      await mgr.runToCompletion(scope);
      return flushCount;
    }
    // 20 pages: open's smaller default interval should flush mid-run more often than
    // archive's larger default interval (trading redo-window size for fewer full rewrites).
    const openFlushes = await countFlushes('open', 20);
    const archiveFlushes = await countFlushes('archive', 20);
    expect(openFlushes).toBeGreaterThan(archiveFlushes);
  });

  it('sets failed state with error message; keeps previously flushed batches', async () => {
    const repo = await freshRepo();
    const adapter = fakeAdapter(async (_s, hooks) => {
      await hooks.onBatch([makePatch(1)]);
      throw new Error('fetch failed after 3 attempts: url');
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW, flushEveryPages: 1 });
    await mgr.runToCompletion('open');
    expect(mgr.status().state).toBe('failed');
    expect(mgr.status().error).toContain('fetch failed');
    expect(repo.getAll()).toHaveLength(1); // flushed page survived
    expect(repo.getMeta('fake').lastScrapedAt).toBeNull(); // not stamped on failure
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend -- manager`
Expected: FAIL — `ScrapeManager` still calls `repo.upsertMany`/`repo.flush(adapter.name)`, and doesn't stamp `total` via `getSourceCount`; `ScrapeHooks.onBatch` is still typed for `Tender[]`.

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `backend/src/scrapers/types.ts`:

```ts
import type { TenderPatch } from '@tms/shared';

export type ScrapeScope = 'all' | 'open' | 'archive';

export interface ScrapeProgress {
  source: string;
  job: string;
  jobsCompleted: number;
  jobsTotal: number;
  currentPage: number;
  lastPage: number;
}

export interface ScrapeHooks {
  onProgress: (p: ScrapeProgress) => void;
  onBatch: (patches: TenderPatch[]) => Promise<void>;
}

export interface ScraperAdapter {
  name: string;
  scrape(scope: ScrapeScope, hooks: ScrapeHooks): Promise<void>;
}
```

Replace the entire contents of `backend/src/scrape/manager.ts`:

```ts
import type { ScrapeScope, ScraperAdapter } from '../scrapers/types.js';
import type { TenderRepository } from '../storage/repository.js';

export interface ScrapeStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  source?: string;
  job?: string;
  jobsCompleted?: number;
  jobsTotal?: number;
  currentPage?: number;
  lastPage?: number;
  error?: string;
}

export class ScrapeManager {
  private current: ScrapeStatus = { state: 'idle' };
  private running = false;

  constructor(
    private readonly adapters: ScraperAdapter[],
    private readonly repo: TenderRepository,
    private readonly opts: {
      flushEveryPages?: number;
      /** Overrides flushEveryPages specifically for scope='open' (small, fast-feedback jobs). */
      flushEveryPagesOpen?: number;
      /** Overrides flushEveryPages specifically for scope='archive'/'all' (large backfill jobs). */
      flushEveryPagesArchive?: number;
      now?: () => string;
    } = {},
  ) {}

  status(): ScrapeStatus {
    return { ...this.current };
  }

  start(scope: ScrapeScope): boolean {
    if (this.running) return false;
    void this.runToCompletion(scope);
    return true;
  }

  async runToCompletion(scope: ScrapeScope): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.current = { state: 'running' };
    const now = this.opts.now ?? (() => new Date().toISOString());
    const flushEvery =
      this.opts.flushEveryPages ??
      (scope === 'open' ? (this.opts.flushEveryPagesOpen ?? 10) : (this.opts.flushEveryPagesArchive ?? 50));

    try {
      for (const adapter of this.adapters) {
        let pagesSinceFlush = 0;
        await adapter.scrape(scope, {
          onProgress: (p) => {
            this.current = { state: 'running', ...p };
          },
          onBatch: async (patches) => {
            this.repo.mergeMany(patches);
            pagesSinceFlush += 1;
            if (pagesSinceFlush >= flushEvery) {
              await this.repo.flush();
              pagesSinceFlush = 0;
            }
          },
        });
        await this.repo.flush();
        const stamp: Parameters<TenderRepository['setMeta']>[1] = {
          lastScrapedAt: now(),
          total: this.repo.getSourceCount(adapter.name),
        };
        if (scope === 'all' || scope === 'archive') stamp.lastArchiveBackfillAt = now();
        await this.repo.setMeta(adapter.name, stamp);
      }
      this.current = { state: 'done' };
    } catch (err) {
      this.current = { state: 'failed', error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.running = false;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w backend -- manager`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrapers/types.ts backend/src/scrape/manager.ts backend/test/manager.test.ts
git commit -m "refactor(backend): ScrapeHooks carries TenderPatch; manager merges and stamps per-source totals via getSourceCount"
```

---

### Task 8: Query layer — drop dedup/status-filter, add fieldCode/hasWinners

**Files:**
- Modify: `backend/src/query/tenders.ts`
- Modify: `backend/test/query.test.ts`

**Interfaces:**
- Consumes: `Tender` from `@tms/shared` (Task 1).
- Produces: `TenderQuery` (drops nothing from before except the removed `source` filter — see note below; gains `fieldCode?: string`, `hasWinners?: boolean`), `TenderPage`, `Facets` (drops `sources`, gains `fieldCodes: string[]`), `queryTenders(tenders, q): TenderPage`, `buildFacets(tenders): Facets`. `dedupeTenders` and `findById` are removed (the repository is deduped by construction — Task 6 — and direct lookup is now `TenderRepository.findByDedupKey`, used straight from `app.ts`).

**Note on dropping the `source`/`sources` filter and facet:** with `sources` now an array per merged record (Task 1/6), a single-value equality filter no longer models the data well, and the design explicitly removes the Source column/filter from the UI (spec: "remove ... Source" column; the merged-record model replaces per-source distinctness with `sources[]` shown on the detail page only). `status` stays as a query capability (list pages set it internally per nav route; it's just no longer a user-facing dropdown — see Task 13).

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `backend/test/query.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend -- query`
Expected: FAIL — `queryTenders`/`buildFacets` don't accept `fieldCode`/`hasWinners`; old `Facets` still has `sources` instead of `fieldCodes`; old `dedupeTenders`/`findById` tests are gone from this file but old exports still force a shape mismatch against the new `Tender` fixtures (no `id`/`source` fields).

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `backend/src/query/tenders.ts`:

```ts
import type { Tender } from '@tms/shared';

export interface TenderQuery {
  search?: string;
  ministry?: string;
  agency?: string;
  category?: string;
  status?: 'open' | 'closed';
  procurementType?: 'quotation' | 'tender' | 'requisition';
  fieldCode?: string;
  hasWinners?: boolean;
  sortBy?: 'advertisedDate' | 'closingDate' | 'indicativePrice';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface TenderPage {
  items: Tender[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Facets {
  ministries: string[];
  agencies: string[];
  categories: string[];
  procurementTypes: string[];
  fieldCodes: string[];
}

const MAX_PAGE_SIZE = 100;

export function queryTenders(tenders: Tender[], q: TenderQuery): TenderPage {
  let items = tenders;

  if (q.search) {
    const needle = q.search.toLowerCase();
    items = items.filter(
      (t) => t.title.toLowerCase().includes(needle) || t.referenceNo.toLowerCase().includes(needle),
    );
  }
  if (q.ministry) items = items.filter((t) => t.ministry === q.ministry);
  if (q.agency) items = items.filter((t) => t.agency === q.agency);
  if (q.category) items = items.filter((t) => t.category === q.category);
  if (q.status) items = items.filter((t) => t.status === q.status);
  if (q.procurementType) items = items.filter((t) => t.procurementType === q.procurementType);
  if (q.fieldCode) items = items.filter((t) => t.fieldCodes.some((c) => c.startsWith(q.fieldCode!)));
  if (q.hasWinners) items = items.filter((t) => t.winners !== null && t.winners.length > 0);

  const sortBy = q.sortBy ?? 'advertisedDate';
  const dir = (q.sortOrder ?? 'desc') === 'asc' ? 1 : -1;
  const sorted = [...items].sort((a, b) => {
    const av = a[sortBy];
    const bv = b[sortBy];
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // nulls last regardless of direction
    if (bv === null) return -1;
    return av < bv ? -dir : av > bv ? dir : 0;
  });

  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, q.pageSize ?? 20));
  return {
    items: sorted.slice((page - 1) * pageSize, page * pageSize),
    total: sorted.length,
    page,
    pageSize,
  };
}

export function buildFacets(tenders: Tender[]): Facets {
  const distinct = (vals: Array<string | null>) =>
    [...new Set(vals.filter((v): v is string => v !== null))].sort();
  return {
    ministries: distinct(tenders.map((t) => t.ministry)),
    agencies: distinct(tenders.map((t) => t.agency)),
    categories: distinct(tenders.map((t) => t.category)),
    procurementTypes: distinct(tenders.map((t) => t.procurementType)),
    fieldCodes: [...new Set(tenders.flatMap((t) => t.fieldCodes))].sort(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w backend -- query`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/query/tenders.ts backend/test/query.test.ts
git commit -m "refactor(backend): query layer drops dedup/source filter, adds fieldCode + hasWinners"
```

---

### Task 9: API — route by reference number, drop alsoAvailableFrom wrapper

**Files:**
- Modify: `backend/src/api/app.ts`
- Modify: `backend/test/app.test.ts`

**Interfaces:**
- Consumes: `computeDedupKey` from `@tms/shared`; `TenderRepository.getAll`/`findByDedupKey` (Task 6); `queryTenders`/`buildFacets` (Task 8).
- Produces: `createApp({repo, manager})` — `GET /api/tenders/:refNo` (was `:id`) responds `{ tender }` (no more `alsoAvailableFrom`); `GET /api/tenders`/`GET /api/tenders/facets` operate on `repo.getAll()` directly (no more `{deduped:true}` option, since storage is deduped by construction). `backend/src/index.ts` needs **no changes** — it only calls `repo.hasSource`/`repo.getMeta`, both unchanged in signature.

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `backend/test/app.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TenderPatch } from '@tms/shared';
import { createApp } from '../src/api/app.js';
import { ScrapeManager } from '../src/scrape/manager.js';
import type { ScrapeHooks } from '../src/scrapers/types.js';
import { TenderRepository } from '../src/storage/repository.js';

let seq = 0;
function patch(overrides: Partial<TenderPatch> = {}): TenderPatch {
  seq += 1;
  return {
    dedupKey: `REF/${seq}`, referenceNo: `REF/${seq}`, title: `TENDER ${seq}`,
    status: 'open', procurementType: 'quotation',
    scrapedAt: '2026-07-07T00:00:00.000Z',
    source: { source: 'myprocurement', sourceId: String(seq), sourceUrl: `https://example.com/${seq}` },
    ministry: 'KEMENTERIAN A', agency: null, category: null, fieldCodes: [],
    advertisedDate: '2026-07-01', closingDate: null, indicativePrice: null,
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
    repo.mergeMany([patch({ title: 'BUMBUNG GELANGGANG' }), patch({ status: 'closed' }), patch()]);
    const all = await request(app).get('/api/tenders');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.page).toBe(1);

    const filtered = await request(app).get('/api/tenders?status=closed');
    expect(filtered.body.total).toBe(1);

    const searched = await request(app).get('/api/tenders?search=bumbung');
    expect(searched.body.total).toBe(1);
  });

  it('GET /api/tenders supports fieldCode and hasWinners filters', async () => {
    repo.mergeMany([
      patch({ fieldCodes: ['220801'] }),
      patch({ winners: [{ name: 'X', price: 1 }] }),
      patch(),
    ]);
    const byField = await request(app).get('/api/tenders?fieldCode=22');
    expect(byField.body.total).toBe(1);
    const awarded = await request(app).get('/api/tenders?hasWinners=true');
    expect(awarded.body.total).toBe(1);
  });

  it('GET /api/tenders rejects invalid query params with 400', async () => {
    const res = await request(app).get('/api/tenders?status=maybe');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('GET /api/tenders/facets returns distinct values including fieldCodes', async () => {
    repo.mergeMany([patch(), patch({ ministry: 'KEMENTERIAN B', fieldCodes: ['010101'] })]);
    const res = await request(app).get('/api/tenders/facets');
    expect(res.status).toBe(200);
    expect(res.body.ministries).toEqual(['KEMENTERIAN A', 'KEMENTERIAN B']);
    expect(res.body.fieldCodes).toEqual(['010101']);
  });

  it('GET /api/tenders/:refNo returns { tender } by reference number; 404 when missing', async () => {
    repo.mergeMany([patch({ dedupKey: 'UTHM/54/P/02', referenceNo: 'UTHM/54/P/02' })]);
    const res = await request(app).get(`/api/tenders/${encodeURIComponent('UTHM/54/P/02')}`);
    expect(res.status).toBe(200);
    expect(res.body.tender.referenceNo).toBe('UTHM/54/P/02');
    expect(res.body.alsoAvailableFrom).toBeUndefined(); // sources[] on the tender itself replaces this

    const missing = await request(app).get('/api/tenders/NOPE');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend -- app`
Expected: FAIL — route is still `/api/tenders/:id` doing `findById(deps.repo.getAll(), ...)` returning `{tender, alsoAvailableFrom}`; `QuerySchema` doesn't accept `fieldCode`/`hasWinners`; `repo.mergeMany` doesn't exist on the old repository (already fixed in Task 6, so this specifically exercises `app.ts` not yet calling the new repo/query APIs).

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `backend/src/api/app.ts`:

```ts
import express from 'express';
import { z } from 'zod';
import { computeDedupKey } from '@tms/shared';
import type { ScrapeManager } from '../scrape/manager.js';
import type { TenderRepository } from '../storage/repository.js';
import { buildFacets, queryTenders } from '../query/tenders.js';

const QuerySchema = z.object({
  search: z.string().optional(),
  ministry: z.string().optional(),
  agency: z.string().optional(),
  category: z.string().optional(),
  status: z.enum(['open', 'closed']).optional(),
  procurementType: z.enum(['quotation', 'tender', 'requisition']).optional(),
  fieldCode: z.string().optional(),
  hasWinners: z.coerce.boolean().optional(),
  sortBy: z.enum(['advertisedDate', 'closingDate', 'indicativePrice']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
});

export function createApp(deps: { repo: TenderRepository; manager: ScrapeManager }) {
  const app = express();

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/tenders/facets', (_req, res) => {
    res.json(buildFacets(deps.repo.getAll()));
  });

  app.get('/api/tenders/:refNo', (req, res) => {
    const key = computeDedupKey(req.params.refNo, req.params.refNo);
    const tender = deps.repo.findByDedupKey(key);
    if (!tender) return res.status(404).json({ error: 'tender not found' });
    res.json({ tender });
  });

  app.get('/api/tenders', (req, res) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.json(queryTenders(deps.repo.getAll(), parsed.data));
  });

  app.post('/api/scrape', (_req, res) => {
    if (!deps.manager.start('open')) {
      return res.status(409).json({ error: 'scrape already running' });
    }
    res.status(202).json({ started: true });
  });

  app.get('/api/scrape/status', (_req, res) => {
    res.json(deps.manager.status());
  });

  return app;
}
```

Route registration order matters: `/api/tenders/facets` is registered before `/api/tenders/:refNo` so Express doesn't match the literal path segment `facets` as a `:refNo` param — this ordering is unchanged from before.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w backend -- app`
Expected: PASS, all tests green.

- [ ] **Step 5: Run the full backend suite**

Run: `npm test -w backend`
Expected: PASS — all of Tasks 3–9's backend changes are now integrated; this is the first point where the whole backend workspace (not just one file's tests) is exercised together.

- [ ] **Step 6: Commit**

```bash
git add backend/src/api/app.ts backend/test/app.test.ts
git commit -m "refactor(backend): route by reference number, drop alsoAvailableFrom wrapper (sources[] replaces it)"
```

---

### Task 10: Frontend API types/client + shared test mocks

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/test/mocks.ts`
- Modify: `frontend/src/test/client.test.ts`

**Interfaces:**
- Consumes: `Tender` from `@tms/shared` (Task 1).
- Produces: `TenderDetail = { tender: Tender }` (was `{ tender, alsoAvailableFrom }`), `Facets` (drops `sources`, gains `fieldCodes: string[]`), `fetchTender(refNo)` (param renamed in meaning, same call shape), everything else in `client.ts` unchanged.

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `frontend/src/test/mocks.ts`:

```ts
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { Facets, ScrapeStatus, Tender, TenderPage } from '../api/types';

export function makeTender(overrides: Partial<Tender> = {}): Tender {
  return {
    dedupKey: 'UTHM/54/P/02/023/2026',
    referenceNo: 'UTHM/54/P/02/023/2026',
    title: 'MENYELENGGARA PERALATAN MAKMAL',
    status: 'open', procurementType: 'quotation',
    ministry: 'KEMENTERIAN PENDIDIKAN TINGGI', agency: 'UTHM',
    category: 'Perkhidmatan Bukan Perunding', fieldCodes: ['060501'],
    advertisedDate: '2026-07-07', closingDate: '2026-07-17', indicativePrice: 28800,
    currency: 'MYR',
    events: [{ label: 'Lawatan Tapak', date: '2026-07-10', address: 'MAKMAL OR, KAJANG' }],
    winners: null,
    raw: {}, scrapedAt: '2026-07-07T12:00:00.000Z',
    sources: [{ source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1' }],
    ...overrides,
  };
}

export const defaultPage: TenderPage = { items: [makeTender()], total: 1, page: 1, pageSize: 20 };
export const defaultFacets: Facets = {
  ministries: ['KEMENTERIAN PENDIDIKAN TINGGI'], agencies: ['UTHM'],
  categories: ['Perkhidmatan Bukan Perunding'], procurementTypes: ['quotation'],
  fieldCodes: ['060501'],
};
export const idleStatus: ScrapeStatus = { state: 'idle' };

export const handlers = [
  http.get('/api/tenders/facets', () => HttpResponse.json(defaultFacets)),
  http.get('/api/tenders/:refNo', ({ params }) =>
    params.refNo === encodeURIComponent('UTHM/54/P/02/023/2026')
      ? HttpResponse.json({ tender: makeTender() })
      : HttpResponse.json({ error: 'tender not found' }, { status: 404 })),
  http.get('/api/tenders', () => HttpResponse.json(defaultPage)),
  http.get('/api/scrape/status', () => HttpResponse.json(idleStatus)),
  http.post('/api/scrape', () => HttpResponse.json({ started: true }, { status: 202 })),
];

export const server = setupServer(...handlers);
```

Replace the entire contents of `frontend/src/test/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { fetchFacets, fetchScrapeStatus, fetchTender, fetchTenders, triggerScrape } from '../api/client';
import { defaultFacets, defaultPage, server } from './mocks';

describe('api client', () => {
  it('fetchTenders passes query params and returns the page', async () => {
    let seenUrl = '';
    server.use(http.get('/api/tenders', ({ request }) => {
      seenUrl = request.url;
      return HttpResponse.json(defaultPage);
    }));
    const page = await fetchTenders({ search: 'makmal', status: 'open' });
    expect(page.total).toBe(1);
    expect(seenUrl).toContain('search=makmal');
    expect(seenUrl).toContain('status=open');
  });

  it('fetchFacets / fetchScrapeStatus / fetchTender return typed bodies', async () => {
    expect(await fetchFacets()).toEqual(defaultFacets);
    expect((await fetchScrapeStatus()).state).toBe('idle');
    expect((await fetchTender('UTHM/54/P/02/023/2026')).tender.referenceNo).toBe('UTHM/54/P/02/023/2026');
  });

  it('fetchTender throws on 404', async () => {
    await expect(fetchTender('NOPE')).rejects.toThrow();
  });

  it('triggerScrape resolves on 202 and throws on 409', async () => {
    await expect(triggerScrape()).resolves.toBeUndefined();
    server.use(http.post('/api/scrape', () => HttpResponse.json({ error: 'running' }, { status: 409 })));
    await expect(triggerScrape()).rejects.toThrow('scrape already running');
  });

  it('fetchTenders omits empty-string params from the query string', async () => {
    let seenUrl = '';
    server.use(http.get('/api/tenders', ({ request }) => {
      seenUrl = request.url;
      return HttpResponse.json(defaultPage);
    }));
    await fetchTenders({ search: '', status: 'open' });
    expect(seenUrl).not.toContain('search=');
    expect(seenUrl).toContain('status=open');
  });

  it('triggerScrape throws a generic error on other non-ok statuses', async () => {
    server.use(http.post('/api/scrape', () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
    await expect(triggerScrape()).rejects.toThrow('scrape trigger failed: 500');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- client`
Expected: FAIL — `frontend/src/api/types.ts` still declares `Tender` with `id`/`source`/`sourceUrl` (via the old `@tms/shared` re-export, already fixed in Task 1, so this is really about `Facets`/`TenderDetail` shape) and `TenderDetail` still requires `alsoAvailableFrom`.

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `frontend/src/api/types.ts`:

```ts
import type { Tender } from '@tms/shared';
export type { Tender };

export interface TenderPage { items: Tender[]; total: number; page: number; pageSize: number }
export interface Facets {
  ministries: string[]; agencies: string[]; categories: string[];
  procurementTypes: string[]; fieldCodes: string[];
}
export interface ScrapeStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  source?: string; job?: string;
  jobsCompleted?: number; jobsTotal?: number;
  currentPage?: number; lastPage?: number;
  error?: string;
}
export interface TenderDetail { tender: Tender }
```

`frontend/src/api/client.ts` needs no functional change — `fetchTender`'s parameter is already just an opaque string that gets `encodeURIComponent`-ed into the URL path; only its meaning changes (reference number instead of internal id), not its code. Verify the existing file already reads:

```ts
import type { Facets, ScrapeStatus, TenderDetail, TenderPage } from './types';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`request failed: ${res.status} ${url}`);
  return res.json() as Promise<T>;
}

export function fetchTenders(params: Record<string, string>): Promise<TenderPage> {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '')).toString();
  return getJson(`/api/tenders${qs ? `?${qs}` : ''}`);
}

export function fetchFacets(): Promise<Facets> {
  return getJson('/api/tenders/facets');
}

export function fetchTender(refNo: string): Promise<TenderDetail> {
  return getJson(`/api/tenders/${encodeURIComponent(refNo)}`);
}

export function fetchScrapeStatus(): Promise<ScrapeStatus> {
  return getJson('/api/scrape/status');
}

export async function triggerScrape(): Promise<void> {
  const res = await fetch('/api/scrape', { method: 'POST' });
  if (res.status === 409) throw new Error('scrape already running');
  if (!res.ok) throw new Error(`scrape trigger failed: ${res.status}`);
}
```

(Only the parameter name `id` → `refNo` changes, purely cosmetic — rename it for clarity while here.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend -- client`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/test/mocks.ts frontend/src/test/client.test.ts
git commit -m "refactor(frontend): TenderDetail drops alsoAvailableFrom, Facets gains fieldCodes"
```

---

### Task 11: FieldCodeFilter component

**Files:**
- Create: `frontend/src/components/FieldCodeFilter.tsx`
- Create: `frontend/src/test/FieldCodeFilter.test.tsx`

**Interfaces:**
- Consumes: `FIELD_CODE_TREE`, `flattenFieldCodes` from `@tms/shared` (Task 2).
- Produces: `<FieldCodeFilter value={string} onChange={(code: string) => void} />` — a searchable dropdown; focusing shows the full flattened tree indented by depth; typing narrows by code-prefix or name-substring match; clicking a row calls `onChange` with that row's full code and closes the dropdown; a "Clear" link appears when `value` is non-empty and resets it to `''`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/test/FieldCodeFilter.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import FieldCodeFilter from '../components/FieldCodeFilter';

describe('FieldCodeFilter', () => {
  it('shows the full tree on focus, indented by depth', async () => {
    render(<FieldCodeFilter value="" onChange={vi.fn()} />);
    await userEvent.click(screen.getByLabelText(/field code/i));
    expect(await screen.findByText(/01 — Penerbitan Dan Penyiaran/)).toBeInTheDocument();
  });

  it('narrows the list when typing a code prefix', async () => {
    render(<FieldCodeFilter value="" onChange={vi.fn()} />);
    const input = screen.getByLabelText(/field code/i);
    await userEvent.click(input);
    await userEvent.type(input, '2208');
    expect(await screen.findByText(/220801/)).toBeInTheDocument();
    expect(screen.queryByText(/010101/)).not.toBeInTheDocument();
  });

  it('narrows the list when typing a name fragment', async () => {
    render(<FieldCodeFilter value="" onChange={vi.fn()} />);
    const input = screen.getByLabelText(/field code/i);
    await userEvent.click(input);
    await userEvent.type(input, 'hotel');
    expect(await screen.findByText(/Hotel\/ Resort/)).toBeInTheDocument();
  });

  it('calls onChange with the selected code and closes the dropdown', async () => {
    const onChange = vi.fn();
    render(<FieldCodeFilter value="" onChange={onChange} />);
    const input = screen.getByLabelText(/field code/i);
    await userEvent.click(input);
    await userEvent.type(input, '220801');
    await userEvent.click(await screen.findByText(/220801 — Kawalan Keselamatan/));
    expect(onChange).toHaveBeenCalledWith('220801');
  });

  it('shows the selected code + name in the input when closed', () => {
    render(<FieldCodeFilter value="220801" onChange={vi.fn()} />);
    expect(screen.getByLabelText(/field code/i)).toHaveValue('220801 — Kawalan Keselamatan (Perlu lesen KDN)');
  });

  it('shows a Clear control when a value is selected, which resets to empty', async () => {
    const onChange = vi.fn();
    render(<FieldCodeFilter value="220801" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(onChange).toHaveBeenCalledWith('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- FieldCodeFilter`
Expected: FAIL with "Cannot find module '../components/FieldCodeFilter'".

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/components/FieldCodeFilter.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { FIELD_CODE_TREE, flattenFieldCodes } from '@tms/shared';

interface Props {
  value: string;
  onChange: (code: string) => void;
}

const FLAT = flattenFieldCodes(FIELD_CODE_TREE);

export default function FieldCodeFilter({ value, onChange }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim();
    if (!needle) return FLAT;
    const lower = needle.toLowerCase();
    return FLAT.filter((n) => n.code.startsWith(needle) || n.name.toLowerCase().includes(lower));
  }, [query]);

  const selected = FLAT.find((n) => n.code === value);
  const displayValue = open ? query : selected ? `${selected.code} — ${selected.name}` : '';

  return (
    <div className="relative flex flex-col text-sm gap-1">
      <label htmlFor="field-code-input">Field Code</label>
      <input
        id="field-code-input"
        className="border rounded-md px-2 py-2"
        placeholder="All"
        value={displayValue}
        onFocus={() => { setOpen(true); setQuery(''); }}
        onChange={(e) => setQuery(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {value && (
        <button
          type="button"
          className="text-xs text-blue-700 underline text-left"
          onMouseDown={() => { onChange(''); setQuery(''); }}
        >
          Clear
        </button>
      )}
      {open && (
        <ul className="absolute top-full z-10 mt-1 max-h-64 w-96 overflow-y-auto border rounded-md bg-white shadow-lg">
          {filtered.map((n) => (
            <li key={n.code}>
              <button
                type="button"
                className="w-full text-left px-2 py-1 hover:bg-blue-50"
                style={{ paddingLeft: `${8 + (n.path.length - 1) * 16}px` }}
                onMouseDown={() => { onChange(n.code); setQuery(''); setOpen(false); }}
              >
                {n.code} — {n.name}
              </button>
            </li>
          ))}
          {filtered.length === 0 && <li className="px-2 py-1 text-gray-500">No matches</li>}
        </ul>
      )}
    </div>
  );
}
```

`onMouseDown` (not `onClick`) is used for row selection and the Clear button so they fire before the input's `onBlur` closes the dropdown — the standard pattern for combobox-style widgets.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend -- FieldCodeFilter`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/FieldCodeFilter.tsx frontend/src/test/FieldCodeFilter.test.tsx
git commit -m "feat(frontend): hierarchical, searchable field-code filter dropdown"
```

---

### Task 12: App shell — left navbar, three list routes

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/test/App.test.tsx`

**Interfaces:**
- Consumes: `TenderListPage` (Task 13 — write this task's test first per TDD, then implement both `App.tsx` and stub out `TenderListPage`'s existence is required for `App.tsx` to import; since Task 13 comes right after, implement Task 13's minimal component signature as part of this task if executing strictly in order, or execute Task 13 before Task 12 — no cross-dependency the other way, so either order is safe. This task assumes `TenderListPage` and `DetailPage` (Task 14) already exist with their final props signatures: `TenderListPage({status, hasWinners?})`, `DetailPage` reading `useParams<{refNo: string}>()`.
- Produces: `App` — left sidebar nav (Open/Closed/Awarded Tenders links), `/` redirects to `/open`, routes `/open`, `/closed`, `/awarded`, `/tenders/:refNo`.

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `frontend/src/test/App.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../App';

describe('App', () => {
  it('renders the heading and all three nav links', () => {
    render(<App />);
    expect(screen.getByText('Malaysia Tender Aggregator')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Tenders' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Closed Tenders' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Awarded Tenders' })).toBeInTheDocument();
  });

  it('redirects the root route to Open Tenders, which renders the list', async () => {
    render(<App />);
    expect(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- App.test`
Expected: FAIL — current `App.tsx` has no nav links and routes only `/` and `/tenders/:id`.

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `frontend/src/App.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import ScrapeBanner from './components/ScrapeBanner';
import DetailPage from './pages/DetailPage';
import TenderListPage from './pages/TenderListPage';

const queryClient = new QueryClient();

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return `block px-4 py-2 rounded-md ${isActive ? 'bg-blue-800 text-white' : 'text-blue-900 hover:bg-blue-50'}`;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="flex min-h-screen">
          <nav className="w-56 shrink-0 bg-white border-r p-4 space-y-1">
            <div className="text-lg font-semibold text-blue-900 mb-4">Malaysia Tender Aggregator</div>
            <NavLink to="/open" className={navLinkClass}>Open Tenders</NavLink>
            <NavLink to="/closed" className={navLinkClass}>Closed Tenders</NavLink>
            <NavLink to="/awarded" className={navLinkClass}>Awarded Tenders</NavLink>
          </nav>
          <div className="flex-1">
            <header className="bg-blue-900 text-white px-6 py-4 flex items-center justify-end">
              <ScrapeBanner />
            </header>
            <main className="p-6">
              <Routes>
                <Route path="/" element={<Navigate to="/open" replace />} />
                <Route path="/open" element={<TenderListPage status="open" />} />
                <Route path="/closed" element={<TenderListPage status="closed" />} />
                <Route path="/awarded" element={<TenderListPage status="closed" hasWinners />} />
                <Route path="/tenders/:refNo" element={<DetailPage />} />
              </Routes>
            </main>
          </div>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend -- App.test`
Expected: PASS once Task 13/14 exist (`TenderListPage`/`DetailPage` with the props/params this file imports them with) — if implementing tasks strictly in written order, this step will only go green after Task 13 and Task 14 land; that's fine, just don't count this task's test as the final gate until the whole frontend suite (final step of Task 14) is green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/test/App.test.tsx
git commit -m "feat(frontend): left navbar with Open/Closed/Awarded routes, replacing the single main page"
```

---

### Task 13: TenderListPage — generalized list page, new columns, field-code filter wired in

**Files:**
- Delete: `frontend/src/pages/MainPage.tsx`
- Delete: `frontend/src/test/MainPage.test.tsx`
- Create: `frontend/src/pages/TenderListPage.tsx`
- Create: `frontend/src/test/TenderListPage.test.tsx`

**Interfaces:**
- Consumes: `fetchFacets`/`fetchTenders` (Task 10), `FieldCodeFilter` (Task 11), `Tender` type (Task 1).
- Produces: `TenderListPage({ status: 'open' | 'closed'; hasWinners?: boolean })` — replaces `MainPage`. Table columns: Title, Reference No, Ministry, Type, Closing Date (sortable), Field Code, plus Won (only when `hasWinners` is true). No Source/Price/Status columns and no Status filter dropdown (status is fixed by the `status` prop, driven by which nav route rendered this page — see Task 12).

- [ ] **Step 1: Write the failing test**

Delete `frontend/src/pages/MainPage.tsx` and `frontend/src/test/MainPage.test.tsx` (superseded by the files below).

Create `frontend/src/test/TenderListPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import TenderListPage from '../pages/TenderListPage';
import { defaultPage, makeTender, server } from './mocks';

function renderList(ui: React.ReactElement, { route = '/' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="/tenders/:refNo" element={<div>DETAIL PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TenderListPage', () => {
  it('renders tender rows without Source/Price/Status columns, with a Field Code column', async () => {
    renderList(<TenderListPage status="open" />);
    expect(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).toBeInTheDocument();
    expect(screen.getByText('UTHM/54/P/02/023/2026')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /source/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^price/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^status/i })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /field code/i })).toBeInTheDocument();
    expect(screen.getByText('060501')).toBeInTheDocument();
  });

  it('sends status as a fixed param, not a user-facing filter', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderList(<TenderListPage status="closed" />);
    await waitFor(() => expect(requests.some((u) => u.includes('status=closed'))).toBe(true));
    expect(screen.queryByLabelText(/^status/i)).not.toBeInTheDocument();
  });

  it('sends hasWinners=true and shows a Won column with formatted winners', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json({
        items: [makeTender({ winners: [{ name: 'EVERLASTING LUCK SDN. BHD.', price: 72000 }] })],
        total: 1, page: 1, pageSize: 20,
      });
    }));
    renderList(<TenderListPage status="closed" hasWinners />);
    await waitFor(() => expect(requests.some((u) => u.includes('hasWinners=true'))).toBe(true));
    expect(screen.getByRole('columnheader', { name: /won/i })).toBeInTheDocument();
    expect(await screen.findByText(/EVERLASTING LUCK SDN\. BHD\. — RM 72,000\.00/)).toBeInTheDocument();
  });

  it('does not show a Won column when hasWinners is not set', async () => {
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    expect(screen.queryByRole('columnheader', { name: /won/i })).not.toBeInTheDocument();
  });

  it('populates filter dropdowns from facets and refetches on change', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    await userEvent.selectOptions(
      await screen.findByLabelText(/ministry/i),
      'KEMENTERIAN PENDIDIKAN TINGGI',
    );
    await waitFor(() =>
      expect(requests.some((u) => u.includes('ministry=KEMENTERIAN'))).toBe(true));
  });

  it('sends search text as a query param (debounced)', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderList(<TenderListPage status="open" />);
    await userEvent.type(screen.getByPlaceholderText(/search/i), 'makmal');
    await waitFor(() => expect(requests.some((u) => u.includes('search=makmal'))).toBe(true), { timeout: 2000 });
  });

  it('sends fieldCode as a query param when selected from the field-code filter', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    const input = screen.getByLabelText(/field code/i);
    await userEvent.click(input);
    await userEvent.type(input, '220801');
    await userEvent.click(await screen.findByText(/220801 — Kawalan Keselamatan/));
    await waitFor(() => expect(requests.some((u) => u.includes('fieldCode=220801'))).toBe(true));
  });

  it('toggles sort direction on second click of the same column', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    const closingDateBtn = screen.getByRole('button', { name: /closing date/i });
    await userEvent.click(closingDateBtn);
    await waitFor(() =>
      expect(requests.some((u) => u.includes('sortBy=closingDate') && u.includes('sortOrder=desc'))).toBe(true));
    await userEvent.click(closingDateBtn);
    await waitFor(() =>
      expect(requests.some((u) => u.includes('sortBy=closingDate') && u.includes('sortOrder=asc'))).toBe(true));
  });

  it('paginates', async () => {
    server.use(http.get('/api/tenders', ({ request }) => {
      const page = new URL(request.url).searchParams.get('page') ?? '1';
      return HttpResponse.json({
        items: [makeTender({ dedupKey: `p${page}`, referenceNo: `p${page}`, title: `PAGE ${page} ITEM` })],
        total: 45, page: Number(page), pageSize: 20,
      });
    }));
    renderList(<TenderListPage status="open" />);
    await screen.findByText('PAGE 1 ITEM');
    expect(screen.getByText(/45/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('PAGE 2 ITEM')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous/i })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: /previous/i }));
    expect(await screen.findByText('PAGE 1 ITEM')).toBeInTheDocument();
  });

  it('navigates to the detail page by reference number on row click', async () => {
    renderList(<TenderListPage status="open" />);
    await userEvent.click(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL'));
    expect(await screen.findByText('DETAIL PAGE')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- TenderListPage`
Expected: FAIL with "Cannot find module '../pages/TenderListPage'".

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/pages/TenderListPage.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Tender } from '../api/types';
import { fetchFacets, fetchTenders } from '../api/client';
import FieldCodeFilter from '../components/FieldCodeFilter';

type SortBy = 'advertisedDate' | 'closingDate' | 'indicativePrice';

const FILTERS = [
  { key: 'ministry', label: 'Ministry', facet: 'ministries' },
  { key: 'agency', label: 'Agency', facet: 'agencies' },
  { key: 'category', label: 'Category', facet: 'categories' },
  { key: 'procurementType', label: 'Type', facet: 'procurementTypes' },
] as const;

function formatWinners(winners: Tender['winners']): string {
  if (!winners || winners.length === 0) return '—';
  return winners
    .map((w) => `${w.name} — ${w.price === null ? 'RM —' : `RM ${w.price.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`}`)
    .join(', ');
}

interface Props {
  status: 'open' | 'closed';
  hasWinners?: boolean;
}

export default function TenderListPage({ status, hasWinners = false }: Props) {
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [fieldCode, setFieldCode] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('advertisedDate');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const h = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
    return () => clearTimeout(h);
  }, [searchInput]);

  const params: Record<string, string> = {
    search, status, sortBy, sortOrder, page: String(page),
    ...(hasWinners ? { hasWinners: 'true' } : {}),
    ...(fieldCode ? { fieldCode } : {}),
    ...filters,
  };
  const { data: pageData } = useQuery({
    queryKey: ['tenders', params],
    queryFn: () => fetchTenders(params),
  });
  const { data: facets } = useQuery({ queryKey: ['facets'], queryFn: fetchFacets });

  const toggleSort = (col: SortBy) => {
    if (sortBy === col) setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortOrder('desc'); }
    setPage(1);
  };
  const sortIndicator = (col: SortBy) => (sortBy === col ? (sortOrder === 'asc' ? ' ▲' : ' ▼') : '');
  const totalPages = pageData ? Math.max(1, Math.ceil(pageData.total / pageData.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <input
          type="search"
          placeholder="Search title or reference no…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="border rounded-md px-3 py-2 w-72"
        />
        {FILTERS.map((f) => (
          <label key={f.key} className="flex flex-col text-sm gap-1">
            {f.label}
            <select
              className="border rounded-md px-2 py-2"
              value={filters[f.key] ?? ''}
              onChange={(e) => {
                setFilters((prev) => ({ ...prev, [f.key]: e.target.value }));
                setPage(1);
              }}
            >
              <option value="">All</option>
              {(facets?.[f.facet] ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
        ))}
        <FieldCodeFilter value={fieldCode} onChange={(c) => { setFieldCode(c); setPage(1); }} />
      </div>

      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Reference No</th>
              <th className="px-3 py-2">Ministry</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">
                <button onClick={() => toggleSort('closingDate')}>Closing Date{sortIndicator('closingDate')}</button>
              </th>
              <th className="px-3 py-2">Field Code</th>
              {hasWinners && <th className="px-3 py-2">Won</th>}
            </tr>
          </thead>
          <tbody>
            {(pageData?.items ?? []).map((t) => (
              <tr
                key={t.dedupKey}
                onClick={() => navigate(`/tenders/${encodeURIComponent(t.referenceNo)}`)}
                className="border-t cursor-pointer hover:bg-blue-50"
              >
                <td className="px-3 py-2 font-medium max-w-xl">{t.title}</td>
                <td className="px-3 py-2 whitespace-nowrap">{t.referenceNo}</td>
                <td className="px-3 py-2">{t.ministry ?? '—'}</td>
                <td className="px-3 py-2 capitalize">{t.procurementType}</td>
                <td className="px-3 py-2 whitespace-nowrap">{t.closingDate ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {t.fieldCodes.length === 0
                    ? '—'
                    : t.fieldCodes.length === 1
                      ? t.fieldCodes[0]
                      : `${t.fieldCodes[0]} +${t.fieldCodes.length - 1}`}
                </td>
                {hasWinners && <td className="px-3 py-2">{formatWinners(t.winners)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-4">
        <span>{pageData?.total ?? 0} tenders</span>
        <button
          className="border rounded-md px-3 py-1 disabled:opacity-50"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous
        </button>
        <span>Page {page} of {totalPages}</span>
        <button
          className="border rounded-md px-3 py-1 disabled:opacity-50"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend -- TenderListPage`
Expected: PASS, all tests green (`App.test.tsx` from Task 12 should now also pass, since `TenderListPage` exists with the right props).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/TenderListPage.tsx frontend/src/test/TenderListPage.test.tsx
git rm frontend/src/pages/MainPage.tsx frontend/src/test/MainPage.test.tsx
git commit -m "feat(frontend): TenderListPage replaces MainPage — Field Code column, no Source/Price/Status"
```

---

### Task 14: DetailPage — reference-number route, drop Source/Scraped At, show winners + sources[]

**Files:**
- Modify: `frontend/src/pages/DetailPage.tsx`
- Modify: `frontend/src/test/DetailPage.test.tsx`

**Interfaces:**
- Consumes: `fetchTender` (Task 10), `Tender` type (Task 1).
- Produces: `DetailPage` reading `useParams<{refNo: string}>()` (was `{id}`); renders a "Winners" row when `tender.winners` is non-null/non-empty; "Also listed on" now derived from `tender.sources` (shown only when `sources.length > 1`); Source and Scraped At rows removed.

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `frontend/src/test/DetailPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import DetailPage from '../pages/DetailPage';
import { makeTender, server } from './mocks';

function renderDetail(refNo: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/tenders/${encodeURIComponent(refNo)}`]}>
        <Routes>
          <Route path="/tenders/:refNo" element={<DetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DetailPage', () => {
  it('renders all tender fields including events and official link, without Source/Scraped At rows', async () => {
    renderDetail('UTHM/54/P/02/023/2026');
    expect(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).toBeInTheDocument();
    expect(screen.getByText('UTHM/54/P/02/023/2026')).toBeInTheDocument();
    expect(screen.getByText('KEMENTERIAN PENDIDIKAN TINGGI')).toBeInTheDocument();
    expect(screen.getByText('UTHM')).toBeInTheDocument();
    expect(screen.getByText('Perkhidmatan Bukan Perunding')).toBeInTheDocument();
    expect(screen.getByText('060501')).toBeInTheDocument();
    expect(screen.getByText('2026-07-17')).toBeInTheDocument();
    expect(screen.getByText(/RM\s*28,800/)).toBeInTheDocument();
    expect(screen.getByText('Lawatan Tapak')).toBeInTheDocument();
    expect(screen.getByText('MAKMAL OR, KAJANG')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /view on official site/i });
    expect(link).toHaveAttribute('href', 'https://example.com/1');
    expect(screen.queryByText(/^Source$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Scraped At$/)).not.toBeInTheDocument();
  });

  it('shows a Winners row when winners are present', async () => {
    server.use(http.get('/api/tenders/:refNo', () => HttpResponse.json({
      tender: makeTender({ winners: [{ name: 'EVERLASTING LUCK SDN. BHD.', price: 72000 }] }),
    })));
    renderDetail('UTHM/54/P/02/023/2026');
    expect(await screen.findByText(/EVERLASTING LUCK SDN\. BHD\. — RM 72,000\.00/)).toBeInTheDocument();
  });

  it('shows "Also listed on" when the tender has more than one contributing source', async () => {
    server.use(http.get('/api/tenders/:refNo', () => HttpResponse.json({
      tender: makeTender({
        sources: [
          { source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1' },
          { source: 'other', sourceId: '9', sourceUrl: 'https://other.example/9' },
        ],
      }),
    })));
    renderDetail('UTHM/54/P/02/023/2026');
    expect(await screen.findByText(/also listed on/i)).toBeInTheDocument();
    expect(screen.getByText('other')).toBeInTheDocument();
  });

  it('does not show "Also listed on" for a single-source tender', async () => {
    renderDetail('UTHM/54/P/02/023/2026');
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    expect(screen.queryByText(/also listed on/i)).not.toBeInTheDocument();
  });

  it('shows an error state for unknown reference numbers', async () => {
    renderDetail('NOPE');
    expect(await screen.findByText(/not found|failed/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- DetailPage`
Expected: FAIL — current `DetailPage.tsx` reads `useParams<{id}>()`, calls `fetchTender(id)`, still renders Source/Scraped At rows, and reads `data.alsoAvailableFrom` (a shape removed in Task 10).

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `frontend/src/pages/DetailPage.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { fetchTender } from '../api/client';
import type { Tender } from '../api/types';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row py-2 border-b last:border-b-0">
      <div className="sm:w-1/3 font-semibold">{label}</div>
      <div className="sm:w-2/3">{value ?? '—'}</div>
    </div>
  );
}

function formatWinners(winners: NonNullable<Tender['winners']>): string {
  return winners
    .map((w) => `${w.name} — ${w.price === null ? 'RM —' : `RM ${w.price.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`}`)
    .join(', ');
}

export default function DetailPage() {
  const { refNo } = useParams<{ refNo: string }>();
  const { data, isError } = useQuery({
    queryKey: ['tender', refNo],
    queryFn: () => fetchTender(refNo!),
    enabled: Boolean(refNo),
  });

  if (isError) return <div className="text-red-700">Tender not found.</div>;
  if (!data) return <div>Loading…</div>;
  const t = data.tender;

  return (
    <div className="max-w-4xl space-y-6">
      <Link to="/open" className="text-blue-700 underline">← Back to all tenders</Link>
      <h1 className="text-xl font-bold">{t.title}</h1>
      <a
        href={t.sources[0]!.sourceUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-block bg-blue-900 text-white rounded-md px-4 py-2"
      >
        View on official site ↗
      </a>

      <div className="border rounded-lg p-4">
        <Field label="Reference No" value={t.referenceNo} />
        <Field label="Status" value={<span className="capitalize">{t.status}</span>} />
        <Field label="Procurement Type" value={<span className="capitalize">{t.procurementType}</span>} />
        <Field label="Ministry" value={t.ministry} />
        <Field label="Agency" value={t.agency} />
        <Field label="Category" value={t.category} />
        <Field label="Field Codes" value={t.fieldCodes.length ? t.fieldCodes.join(', ') : null} />
        <Field label="Advertised" value={t.advertisedDate} />
        <Field label="Closing" value={t.closingDate} />
        <Field
          label="Indicative Price"
          value={t.indicativePrice === null ? null
            : `RM ${t.indicativePrice.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`}
        />
        {t.winners && t.winners.length > 0 && (
          <Field label="Winners" value={formatWinners(t.winners)} />
        )}
      </div>

      {t.events.length > 0 && (
        <div>
          <h2 className="font-semibold mb-2">Events</h2>
          <table className="w-full text-sm border rounded-lg">
            <thead className="bg-gray-100 text-left">
              <tr><th className="px-3 py-2">Event</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Address</th></tr>
            </thead>
            <tbody>
              {t.events.map((e, i) => (
                <tr key={i} className="border-t">
                  <td className="px-3 py-2">{e.label}</td>
                  <td className="px-3 py-2">{e.date ?? '—'}</td>
                  <td className="px-3 py-2">{e.address ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {t.sources.length > 1 && (
        <div>
          <h2 className="font-semibold mb-2">Also listed on</h2>
          <ul className="list-disc pl-6">
            {t.sources.map((s) => (
              <li key={s.source}>
                <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-700 underline">{s.source}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend -- DetailPage`
Expected: PASS, all tests green.

- [ ] **Step 5: Run the full frontend suite, then the whole repo**

Run: `npm test -w frontend`
Expected: PASS — this is the first point every frontend file from Tasks 10–14 is exercised together (`App.test.tsx` from Task 12 should now pass too).

Run: `npm test`
Expected: PASS across `shared`, `backend`, and `frontend` workspaces, with coverage thresholds (80%/80% lines/branches) met in each. This is the same check husky's pre-commit hook runs — if it fails here, fix before committing rather than discovering it at commit time.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/DetailPage.tsx frontend/src/test/DetailPage.test.tsx
git commit -m "feat(frontend): detail page keyed by reference number, shows winners and sources[]"
```

---

## After all tasks: manual verification

Delete `backend/data/` (old per-source shape, dev-only) and run `npm run dev -w backend` once to confirm the startup full-rescrape repopulates it under the new single-`tenders.json` shape, then `npm run dev -w frontend` and click through: Open → Closed → Awarded nav, the field-code filter (type a partial code, click a result, confirm the list filters), and a Closed tender's detail page showing a Winners row if one has been backfilled with results data yet (results jobs run as part of archive backfill, so this may take a few minutes on a fresh backfill — check `GET /api/scrape/status` for progress). This is a manual smoke check, not part of the automated suite — the automated tests above are the actual gate.
