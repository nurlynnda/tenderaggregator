# Navbar, Awarded Tenders, Merged Records & Field-Code Filter — Design

Date: 2026-07-08
Status: Approved by user, pending spec self-review sign-off

## Context

Follow-up feature batch to the initial tender aggregator (see
`2026-07-07-tender-aggregator-design.md`). Adds:

1. A left navbar splitting the single tender list into three pages: Open, Closed, Awarded.
2. Awarded-tender winner data, sourced from previously-unused MyProcurement archive
   categories `results-quotation` / `results-tender`.
3. Column changes across the tender tables and detail page.
4. A route change from an internal id to the tender's reference number.
5. A hierarchical field-code filter, built from the official
   "Senarai Kod Bidang Bekalan Dan Perkhidmatan" (Versi 2.0) PDF.

While designing the winner-merge mechanism, we surfaced a broader problem in the existing
dedup architecture (see Decision Log) and decided to fix it now rather than defer it.

## Empirical findings (verified via live curl, not assumed)

- `type=archive&category=results-quotation` and `type=archive&category=results-tender` are
  valid and return JSON in the same `{html, total, page, lastPage}` shape as every other job.
- `type=archive&category=results-requisition` is **not valid** — it returns an HTML error
  page, not JSON. Confirmed by request; there is no requisition-with-winner category.
- A results card has the same `No. Sebut Harga`/`No. Tender` reference number as the
  corresponding archive card, plus `Kementerian`, `Agensi`, `Kategori Perolehan` (all
  present) — but **no** `Kod Bidang`, `Tarikh Tutup Pelawaan`, or `Harga Indikatif Jabatan`
  (all absent from the DOM, not merely empty).
- Each results card has a winner table: one row per winner, columns "Nama Petender Berjaya"
  (name) and "Harga Setuju Terima (RM)" (accepted price). A tender can have **more than one
  winner** (confirmed: a real fetched card had 2 rows, for a multi-lot award).
- A results card's DOM id (`select-procurement`'s `{ id: N }`) is a different numeric id
  than the archive card's — they are not the same `sourceId`, only the same reference number.
- The 6-digit field codes seen in real scraped data (e.g. `220801`) decompose as three
  2-digit levels matching the PDF's nesting exactly: `22` (PERKHIDMATAN) → `08` (Pertahanan
  Dan Keselamatan) → `01` (Kawalan Keselamatan). The PDF's own changelog cross-checks this
  (`222501` → Hotel/Resort, `040103` → Makanan Bermasak (Islam)) and both match the tree
  below exactly.

## Decision log (from brainstorming)

- **Winner merge**: winners are an enrichment of an existing tender record, not a new
  tender. Chosen approach: merge into the existing record (not a separate joined store).
- **This forced a bigger question**: a targeted "merge a patch into an existing record"
  primitive is exactly what real cross-source dedup will eventually need too (today there's
  one source; the current design already anticipated more). Decision: build the general
  merge-by-`dedupKey` model now, replacing the existing per-source-storage +
  query-time-`dedupeTenders` approach, rather than bolting on a one-off winners patch and
  redoing this later.
- **Conflict resolution**: most-recent-scrape-wins, per field — refined during design to
  **most-recent-non-null-wins**: a later patch that simply didn't observe a field (value
  absent/null) must not erase a previously known value. This is a deliberate refinement of
  the user's original answer, flagged here for visibility.
- **Detail route**: becomes `/tenders/<referenceNo>` (URL-encoded), resolved by normalizing
  the same way `computeDedupKey` does. Since storage is now merge-by-`dedupKey`, this is a
  direct lookup — `id` as a separate concept is retired, the record's key **is** its
  `dedupKey`.
- **Field code filter**: prefix match. Picking `22` matches any tender with a field code
  starting `22`; a full 6-digit leaf code matches exactly (no descendants to include).
- **Awarded scope**: only quotation/tender procurement types can ever have winners (no
  `results-requisition`). No special-case filtering needed — the Awarded page's query is
  "closed tenders with `winners` populated," and requisitions simply never satisfy that.
- **"Also listed on"**: kept, but now reads the merged record's `sources` array directly
  instead of scanning sibling per-source records at query time.

## Schema changes (`shared/src/tender.ts`)

```ts
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
```

`TenderSchema` changes:
- Remove `id`, `source`, `sourceId`, `sourceUrl`.
- Add `sources: TenderSourceSchema.array().min(1)`.
- Add `winners: WinnerSchema.array().nullable()` (`null` = no result data seen yet).
- Everything else (`referenceNo`, `dedupKey`, `title`, `status`, `procurementType`,
  `ministry`, `agency`, `category`, `fieldCodes`, `advertisedDate`, `closingDate`,
  `indicativePrice`, `currency`, `events`, `raw`, `scrapedAt`) is unchanged in meaning.

A record's storage key and API-visible identifier is its `dedupKey` (no separate `id`).
`computeDedupKey(referenceNo, fallbackSourceRef)` keeps its normalization logic; the
fallback (used only when `referenceNo` is empty) becomes the first contributing
`source:sourceId` composite instead of a pre-existing `id`.

### Patch schema (what adapters actually emit)

```ts
export const TenderPatchSchema = z.object({
  dedupKey: z.string().min(1),
  referenceNo: z.string(),
  title: z.string().min(1),
  status: z.enum(['open', 'closed']),
  procurementType: z.enum(['quotation', 'tender', 'requisition']),
  scrapedAt: z.string(),
  source: TenderSourceSchema,
  // Everything below is optional — a patch only carries what its job actually observed.
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

A "full" job (the existing 6 open/archive jobs) populates every optional field — in
practice indistinguishable from today's full `Tender`, just shaped as a patch. A
"results" job populates only `winners` (plus the required identity fields) and omits the
rest entirely.

## Storage: merge-by-dedupKey (`backend/src/storage/repository.ts`)

Replaces `Map<source, Map<id, Tender>>` + query-time `dedupeTenders`/`getDeduped` with:

- `merged: Map<dedupKey, Tender>` — the one canonical record per tender, persisted as a
  single `data/tenders.json`.
- `fieldProvenance: Map<dedupKey, Record<string, string>>` — tracks the `scrapedAt` that
  last wrote each field, persisted as `data/field-provenance.json`. Internal bookkeeping,
  never exposed via the API or included in `TenderSchema`.
- Per-source `meta.json` (`lastScrapedAt`, `lastArchiveBackfillAt`, `total`) is unchanged —
  it tracks scrape-job progress, which is still inherently per-source/per-adapter.

`mergeMany(patches: TenderPatch[])` replaces `upsertMany`:
- If no record exists yet for a patch's `dedupKey`: seed a new record — fields not present
  in the patch default to their empty value (`null` for scalars, `[]` for arrays,
  `null` for `winners`), `sources: [patch.source]`.
- If a record exists: for every field the patch actually includes (checked via
  `Object.hasOwn`, not just non-undefined, so an explicit `null` still participates), if the
  patch's `scrapedAt` is newer than that field's tracked provenance AND the incoming value
  is non-null (or the field itself is currently unset), overwrite the field and bump its
  provenance to `patch.scrapedAt`. Append `patch.source` to `sources` if not already present
  (dedup by `source` name — a re-scrape from the same source updates in place rather than
  appending a duplicate entry).
- `identity` fields (`referenceNo`, `title`, `status`, `procurementType`) are always
  present in every patch and follow the same most-recent-wins rule as any other field.

`getAll()` returns `[...merged.values()]` directly — the store is already deduped by
construction, so `dedupeTenders`, `getDeduped`, and the `opts.deduped` parameter threaded
through `queryTenders`/`buildFacets`/the API routes in the previous review's fix wave are
all **deleted**. This is a net simplification, not a relocation of complexity.

`flush()` writes the single `data/tenders.json` (and `data/field-provenance.json`)
regardless of which job triggered it — there is no longer a per-source file to scope the
write to. The existing scope-aware `flushEveryPages` cadence tuning (from the prior
final-branch review) still applies and still matters, since every flush is now a full-file
rewrite of the whole dataset (this was already true per-source before; it's the same cost
profile, just one file instead of N).

`findById(dedupKey)` is a direct map lookup; "also listed on" is just
`tender.sources.filter(s => s.source !== <the one currently viewed, if we ever show that>)`
— in practice the detail page just lists every entry in `sources`.

## Scraper contract (`backend/src/scrapers/types.ts`)

```ts
export interface ScrapeHooks {
  onProgress: (p: ScrapeProgress) => void;
  onBatch: (patches: TenderPatch[]) => Promise<void>;
}
```

`onBatch` now carries `TenderPatch[]`, validated against `TenderPatchSchema` (not the full
`TenderSchema`). Invalid patches are logged and skipped, same as today.

### MyProcurement adapter changes

`MYPROCUREMENT_JOBS` gains two entries, scoped under `'archive'`/`'all'` (never `'open'` —
results only exist for closed procurements):

```ts
{ status: 'closed', procurementType: 'quotation', type: 'archive', category: 'results-quotation', kind: 'results' },
{ status: 'closed', procurementType: 'tender', type: 'archive', category: 'results-tender', kind: 'results' },
```

(Existing 6 jobs get an implicit `kind: 'full'`.) New `parseResultsHtml(html, ctx)` sibling
to `parseListingHtml`, reusing the existing label/value-row and table-row parsing helpers
from `parsing/text.ts`, emits one `TenderPatch` per card with only `dedupKey`, `referenceNo`,
`title`, `status`, `procurementType`, `source`, `scrapedAt`, and `winners` set (parsing every
winner row: name + `parseRmPrice` on the accepted-price cell).

Total jobs: 3 open (`'open'` scope) + 5 closed (3 archive + 2 results, `'archive'`/`'all'`
scope) = 8.

## Query layer (`backend/src/query/tenders.ts`)

- `dedupeTenders` is deleted.
- `queryTenders`/`buildFacets` drop the `opts.deduped` parameter — they always operate on
  the flat `Tender[]` from `repo.getAll()`.
- `TenderQuery` drops `status` (superseded by which nav page is active — see below) and
  gains `fieldCode?: string`, matched by prefix: `t.fieldCodes.some(c => c.startsWith(q.fieldCode))`.
- `Facets` gains `fieldCodes: string[]` (distinct codes actually present in the data — used
  only to decide which tree nodes are worth rendering as non-empty, if we choose to grey out
  empty branches; not required for correctness).
- List pages fix `status` themselves rather than exposing it as a user-facing filter:
  Open → `status: 'open'`; Closed → `status: 'closed'`; Awarded → `status: 'closed'` +
  a new always-on predicate `winners !== null && winners.length > 0` (implemented as a
  `hasWinners?: boolean` query flag rather than overloading `fieldCode`-style filters).

## API (`backend/src/api/app.ts`)

- `GET /api/tenders/:refNo` (was `:id`) — normalizes `refNo` via `computeDedupKey`-style
  normalization, looks up `merged.get(normalized)` directly. 404 if absent.
- `GET /api/tenders` / `GET /api/tenders/facets` — `QuerySchema` drops `status`, adds
  `fieldCode` and `hasWinners`.
- No other route shape changes.

## Frontend

**Layout**: `App.tsx` restructures to a left sidebar (nav: Open Tenders / Closed Tenders /
Awarded Tenders) + main content area, replacing the current top-header-only layout. Routes:
`/` redirects to `/open`, plus `/open`, `/closed`, `/awarded`, `/tenders/:refNo`.

**Shared list page**: `MainPage.tsx` is generalized into a `TenderListPage` that takes fixed
query params (`status`, optionally `hasWinners`) and is instantiated three times (once per
nav route) rather than duplicating the table/filter UI three times.

**Table columns** (all three list pages): remove Source, Price, Status; add Field Code
(render as the joined `fieldCodes` list, or first code + `+N` if more than one). Awarded
page additionally replaces the (already-removed) Price column concept with a Won column:
each winner rendered as `NAME — RM price` (comma/newline-joined if more than one).

**Detail page**: remove Source and Scraped At rows. "Also listed on" section now maps
`tender.sources` directly (each entry's `sourceUrl`/`source` name) instead of querying
sibling records.

**Field-code filter**: a new `FieldCodeFilter` component — a searchable/typeable dropdown
backed by a generated `shared/src/fieldCodes.ts` tree (see Appendix — hand-verified against
the source PDF and cross-checked against real scraped codes). Renders indented
category → sub-category → leaf rows as `CODE — Name`; typing narrows the visible tree to
matching codes/names; clicking any node (at any level) sets the active filter to that node's
code, applied as a prefix match by the query layer.

## Migration note

Existing local `backend/data/` is in the old per-source shape (`data/myprocurement/tenders.json`)
and won't parse under the new single merged `data/tenders.json`. No migration script — this
is pre-launch dev-only data. Documented fix: delete `backend/data/` once; the startup
full-rescrape (already idempotent/resumable) repopulates it under the new shape.

## Appendix: field-code hierarchy (source of truth for `shared/src/fieldCodes.ts`)

Extracted from "Senarai Kod Bidang Bekalan Dan Perkhidmatan - Versi 2.0" via `pdftotext`,
hand-verified line-by-line against the rendered text (not regex-guessed, since the PDF's
indentation is inconsistent across page breaks). 16 top-level categories: `01`–`14`, `21`,
`22`. Category `22` (PERKHIDMATAN) has 29 sub-categories (`01`–`29`); all other categories
have far fewer. Full 3-level tree (`main / sub / leaf`, code = concatenation of the three
2-digit parts):

```
01 PENERBITAN DAN PENYIARAN
  01 Penerbitan: 01 Bahan Bacaan Terbitan Luar Negara / 02 Bahan Bacaan / 03 Penerbitan Elektronik Atas Talian / 04 Bahan Penerbitan Elektronik Dan Muzik/ Lagu (Siap Cetak)
  02 Kertas: 01 Kertas / 99 Pembuat
  03 Peralatan Penerbitan/ Percetakan: 01 Peralatan Percetakan Serta Aksesori / 02 Peralatan Sistem Bunyi, Pembesar Suara Dan Projektor / 03 Peralatan/ Perkakasan Penyuntingan/ Persembahan / 04 Medium Penyimpanan / 99 Pembuat
  04 Papan Tanda Dan Aksesori: 01 Papan Tanda Dan Aksesori / 99 Pembuat
  05 Fotografi Dan Filem: 01 Kamera Dan Aksesori / 02 Peralatan Pemprosesan Fotografi, Mikrofilem / 03 Filem Dan Mikrofilem / 04 Filem Siap Untuk Tayangan (Lesen B FINAS - Pengedar) / 99 Pembuat
  06 Peralatan Pendidikan Dan Latihan: 01 Kit Pendidikan / 02 Bahan Pendidikan / 99 Pembuat

02 PERABOT, PERALATAN PEJABAT, HIASAN DALAMAN DAN DOMESTIK
  01 Perabot, Kelengkapan Dan Aksesori: 01 Perabot, Perabot Makmal Dan Kelengkapan Berasaskan Kayu/ Rotan/ Fabrik/ Logam/ Plastik (Workstation) / 02 Barangan Hiasan Dalaman Dan Aksesori / 03 Permaidani/ Ambar / 99 Pembuat
  02 Mesin-mesin Pejabat Dan Aksesori: 01 Mesin-mesin Pejabat Dan Aksesori / 99 Pembuat
  03 Perkakas Elektrik Dan Elektronik: 01 Perkakas Elektrik Dan Aksesori / 02 Perkakas Elektronik Dan Aksesori / 99 Pembuat
  04 Peralatan Dan Perkakas Domestik: 01 Peralatan Dan Perkakas Domestik (Termasuk Barang-barang Yang Tidak Lekat Di Badan) / 02 Perkakasan Dan Bahan Kebersihan Diri Dan Mandian, Kelengkapan Bilik Air Dan Aksesori / 03 Bahan Pencuci Dan Pembersihan / 04 Solekan Dan Andaman / 99 Pembuat
  05 Bahan Pembungkusan/ Bekas: 01 Bahan Pembungkusan/ Bekas/ Kotak/ Palet / 99 Pembuat
  06 Bekalan Pejabat Dan Alatulis: 01 Alatulis (Tidak Termasuk Borang Dan Semua Jenis Kertas) / 02 Bahan Surih, Drafting Dan Alat Lukis / 03 Organiser, Dairi, Kalendar, Buku Alamat, Resit, Memo / 04 Tag/ Label/ Tanda Dan Stiker / 99 Pembuat
  07 Tekstil: 01 Tekstil / 99 Pembuat
  08 Pakaian Dan Kelengkapan: 01 Pakaian / 02 Kelengkapan Pakaian / 03 Bagasi Dan Beg Dari Kulit/ PVC/ Kanvas/ Kain/ Nylon/ Plastik/ Logam/ Dll / 04 Pakaian Keselamatan, Kelengkapan Dan Aksesori / 99 Pembuat
  09 Bahan Tarpaulin Dan Kanvas: 01 Bahan Tarpaulin Dan Kanvas / 99 Pembuat
  10 Aksesori Dan Bekalan Jahitan: 01 Butang Dan Bekalan Jahitan (Kits) / 99 Pembuat

03 SUKAN, REKREASI DAN ALAT MUZIK
  01 Pakaian Sukan Dan Aksesori: 01 Pakaian Sukan Dan Aksesori / 99 Pembuat
  02 Cenderamata Dan Hadiah: 01 Cenderamata Dan Hadiah / 99 Pembuat
  03 Alat Muzik: 01 Alat Muzik Dan Aksesori / 99 Pembuat
  04 Peralatan Dan Aksesori Perkhemahan Dan Aktiviti Luar: 01 Peralatan Perkhemahan Dan Aktiviti Luar / 02 Peralatan Memancing / 03 Peralatan Memburu / 99 Pembuat
  05 Peralatan Sukan Padang, Gelanggang, Rekreasi, Taman Permainan, Kecergasan Dan Sukan Air: 01 Peralatan Sukan / 99 Pembuat

04 MAKANAN, MINUMAN DAN BAHAN MENTAH
  01 Makanan, Minuman Dan Bahan Mentah Kering/ Basah: 01 Makanan Dan Bahan Mentah Kering/ Basah / 02 Makanan Dan Minuman (Tin, Botol Dan Bungkus) / 03 Makanan Bermasak (Islam) / 04 Makanan Bermasak (Bukan Islam) / 99 Pembuat

05 PERALATAN HOSPITAL, PERUBATAN, UBAT-UBATAN DAN FARMASEUTIKAL
  01 Peralatan Hospital, Bahan Dan Kelengkapan Perubatan: 01 Peralatan Dan Kelengkapan Hospital / 02 Peralatan Dan Kelengkapan Perubatan / 03 Peralatan Untuk Orang Kurang Upaya Dan Pemulihan / 99 Pembuat
  02 Ubat Dan Bahan Ubatan: 01 Dadah Berjadual / 02 Racun Berjadual / 03 Ubat Tidak Berjadual / 04 Makanan/ Minuman Tambahan (Food Suppliment) / 99 Pembuat
  03 Pekakas, Tekstil dan Pakaian Perubatan Pakai Buang/ Guna Semula: 01 Pekakas Perubatan Pakai Buang / 02 Pakaian/ Tekstil Pakai Buang Kakitangan/ Pesakit / 03 Pakaian/ Tekstil Guna Semula Kakitangan/ Pesakit / 99 Pembuat

06 KIMIA, BAHAN KIMIA DAN PERALATAN MAKMAL
  01 Kimia: 01 Kimia Makmal / 02 Kimia Industri / 03 Kimia Memproses Air / 04 Kimia Memproses Filem/ Fotografi / 99 Pembuat
  02 Bahan Biokimia Dan Gas: 01 Bahan Peledak / 02 Bunga Api Dan Mercun / 03 Pencucuh/ Alat Penghasil Nyalaan / 04 Gas (Industri Dan Domestik) / 05 Pewarna/ Pencelup/ Lilin / 99 Pembuat
  03 Bahan Bakar Dan Pelincir: 01 Bahan Bakar / 02 Bahan Pelincir / 03 Bahan Api Nuklear / 99 Pembuat
  04 Cat, Anti Kakis Dan Bahan Tambah: 01 Cat / 02 Anti Kakis/ Bahan Tambah / 99 Pembuat
  05 Peralatan Makmal: 01 Peralatan Makmal Serta Aksesori / 02 Peralatan Makmal Pengukuran, Pencerapan Dan Sukat / 99 Pembuat

07 PERTANIAN, PERHUTANAN DAN TERNAKAN
  01 Baja Dan Racun: 01 Baja Dan Nutrien Tumbuhan (Organik/ Bukan Organik) / 02 Racun Serangga/ Perosak, Rumpai/ Tumbuhan / 99 Pembuat
  02 Tanaman, Ternakan, Baka Tanaman/ Ternakan Dan Sampel: 01 Tanaman/ Baka/ Benih Semaian / 02 Haiwan Ternakan/ Bukan Ternakan Dan Akuatik / 03 Sampel Dan Sampel Awetan Haiwan/ Akuatik/ Serangga/ Tumbuhan
  03 Ubat, Makanan Ternakan/ Tumbuhan, Peralatan Dan Aksesori: 01 Ubat Haiwan/ Akuatik / 02 Makanan Haiwan/ Akuatik / 03 Peralatan Dan Kelengkapan Pertanian/ Ternakan/ Akuatik / 04 Hasil Sampingan Dan Sisa Perladangan / 05 Habitat Dan Tempat Kurungan Haiwan / 06 Peralatan Pengawalan Perosak Tanaman / 99 Pembuat

08 KEJURUTERAAN AWAM, BINAAN DAN KELENGKAPAN KEMUDAHAN AWAM
  01 Kelengkapan/ Kemudahan Awam: 01 Kelengkapan/ Kemudahan Awam (Kecuali Kelengkapan Kemudahan Permainan/ Sukan) / 02 Kontena / 99 Pembuat

09 BAHAN BINAAN DAN PERALATAN KESELAMATAN JALAN RAYA
  01 Bahan Binaan: 01 Bahan Binaan / 02 Paip Dan Kelengkapan / 99 Pembuat
  02 Peralatan Keselamatan Jalan Raya: 01 Peralatan Keselamatan/ Perabot Jalan Raya / 99 Pembuat

10 PERALATAN SUKATAN DAN UKURAN
  01 Peralatan Sukatan Dan Ukuran: 01 Semua Peralatan Sukatan/ Ukuran / 99 Pembuat

11 PENGANGKUTAN, KOMPONEN DAN AKSESORI
  01 Kenderaan Bermotor Dan Tidak Bermotor: 01 Basikal / 02 Motosikal / 03 Kereta / 04 Lori / 05 Bas / 06 Kenderaan Kegunaan Khusus / 99 Pembuat
  02 Jentera Berat: 01 Jentera Berat / 02 Kren / 03 Trailer Dan Aksesori / 99 Pembuat
  03 Alat Ganti Dan Aksesori Kenderaan/ Jentera Berat: 01 Alat Ganti/ Aksesori Kenderaan / 02 Alat Ganti/ Aksesori Jentera Berat / 03 Enjin Kenderaan/ Jentera Berat / 04 Peralatan Servis Dan Selenggara / 99 Pembuat
  04 Kenderaan Ber Rel, Peralatan Dan Alat Ganti: 01 Kenderaan Ber Rel, Peralatan Dan Kereta Kabel / 02 Lokomotif Dan Troli Elektrik / 03 Sistem, Peralatan, Alat Ganti Keretapi Dan Aksesori / 99 Pembuat
  05 Pesawat Udara, Kapal Terbang, Kapal Angkasa, Satelit, Radar: 01 Pesawat Udara / 02 Helikopter / 03 Alatganti Dan Kelengkapan Pesawat/ Helikopter / 04 Kapal Angkasa Dan Alatganti / 05 Satelit Dan Alatganti / 06 Radar Dan Alatganti / 07 Simulator / 99 Pembuat
  06 Bot Dan Kapal: 01 Bot / 02 Kapal Laut/ Kapal Selam / 03 Alat Ganti Dan Kelengkapan Bot/ Kapal/ Kapal Selam / 04 Simulator Bot/ Kapal/ Kapal Selam / 99 Pembuat
  07 Peralatan Marin: 01 Peralatan Marin / 99 Pembuat

12 PERTAHANAN DAN KESELAMATAN
  01 Senjata, Peluru, Bahan Letupan Dan Aksesori: 01 Senjata Api / 02 Peluru Dan Bom / 03 Aksesori Senjata Api / 04 Bahan Letupan/ Complete Rounds / 99 Pembuat
  02 Kelengkapan Sasaran: 01 Kelengkapan Sasaran / 99 Pembuat
  03 Misil, Roket Dan Sub-Sistem: 01 Peluru Berpandu / 02 Sub Sistem Roket / 03 Pelancar Misil Dan Roket / 99 Pembuat
  04 Peralatan Keselamatan Dan Penguatkuasaan: 01 Alat Keselamatan, Perlindungan Dan Kawalan Perlindungan Dan Kawalan / 02 Alat Forensik Dan Aksesori / 99 Pembuat
  05 Pengesanan, Pemantauan Dan Perlindungan: 01 Kunci, Perkakasan Perlindungan Dan Aksesori / 02 Peralatan Pemantauan Dan Pengesanan / 03 Lesen/ Pengenalan Dan Pas Keselamatan Bersalut (Laminated) / 99 Pembuat
  06 Perlindungan Kebakaran: 01 Sistem Pencegah Kebakaran / 02 Peralatan Kawalan Api / 99 Pembuat

13 PERALATAN KEJURUTERAAN DAN MESIN PENGELUARAN
  01 Mesin, Kelengkapan Bengkel Dan Mesin Pengeluaran: 01 Mesin Dan Kelengkapan Bengkel / 02 Mesin Dan Kelengkapan Khusus / 99 Pembuat
  02 Janakuasa Elektrik Dan Peralatan Generator/ Alat Ganti Dan Bateri: 01 Janakuasa, Peralatan/ Alat Ganti/ Aksesori (Secondary) / 02 Mesin Dan Kelengkapan Khusus / 99 Pembuat
  03 Sistem Kumbahan: 01 Peralatan Sistem Kumbahan Dan Aksesori / 99 Pembuat
  04 Peralatan Perindustrian Minyak: 01 Peralatan Perindustrian Huluan / 02 Peralatan Perindustrian Hiliran / 99 Pembuat

14 PERALATAN KEJURUTERAAN ELEKTRIK DAN ELEKTRONIK
  01 Mesin Dan Jentera Penjanaan Dan Pengagihan Tenaga Elektrik Serta Aksesori: 01 Motor Dan Alat Ubah/ Alat Ganti / 02 Enjin, Komponen Enjin Dan Aksesori / 03 Komponen Enjin Pembakaran Dalaman/ Gas Turbine / 99 Pembuat
  02 Stesen Janakuasa Elektrik Dan Peralatan Generator/ Alat Ganti Dan Bateri: 01 Stesen Janakuasa, Peralatan/ Alat Ganti/ Aksesori (Primary) / 02 Penjana Kuasa / 03 Alat Penyimpan Tenaga Dan Aksesori / 99 Pembuat
  03 Kabel, Wayar Elektrik Dan Aksesori: 01 Kabel Elektrik Dan Aksesori / 02 Wayar Elektrik Dan Aksesori / 99 Pembuat
  04 Peralatan Untuk Tenaga Atom Dan Nuklear: 01 Reaktor Dan Instrumen Nuklear / 99 Pembuat
  05 Sistem, Komponen Elektrik, Elektronik, Lampu Dan Aksesori: 01 Sistem Elektronik / 02 Komponen Dan Aksesori Elektrik/ Elektronik / 03 Lampu, Komponen Lampu Dan Aksesori / 99 Pembuat

21 ICT (INFORMATION COMMUNICATION TECHNOLOGY)
  01 Peralatan Dan Kelengkapan Komputer, Perkakasan Dan Komponen: 01 Hardware (Low End Technology) / 02 Hardware (High End Technology) / 03 Software / 04 Software/ System Development/ Customization and Maintenance / 05 Telecommunication/ Networking / 06 Data Management / 07 ICT Security and Firewall, Encryption, PKI, Anti Virus / 08 Multimedia-Products, Services and Maintenance / 09 Hardware and Software Leasing/ Renting / 10 Geographic Information System (GIS) and Services / 11 Independent Verification and Validation (IV&V) / 99 Pembuat
  02 Peralatan Dan Kelengkapan Telekomunikasi: 01 Alat Perhubungan / 02 Sistem Perhubungan/ Telekomunikasi / 03 Aksesori Penghubung Dan Telekomunikasi / 99 Pembuat

22 PERKHIDMATAN
  01 Penyelenggaraan Dan Pembaikan Kenderaan: 01 Basikal / 02 Motosikal / 03 Kenderaan Kegunaan Khusus / 04 Kenderaan Bawah 3 Ton / 05 Kenderaan Melebihi 3 Ton / 06 Jentera Berat / 07 Kerja-Kerja Khusus (Baikpulih Enjin) Dan Sebagainya / 08 Kerja-Kerja Mengetuk dan Mengecat / 09 Alat Hawa Dingin Kenderaan / 10 Membaik Pulih Tempat Duduk/ Kusyen Dan Bumbung / 11 Kerja-Kerja Pembaikan Kenderaan Ber Rel Dan Kereta Kabel / 12 Kerja-Kerja Penyelenggaraan Sistem Kenderaan / 13 Membaik Pulih Tayar / 14 Membaik Pulih Bateri / 15 Kenderaan Pertahanan/ Keselamatan Negara – Motosikal / 16 Kenderaan Pertahanan/ Keselamatan Negara – Kenderaan Kegunaan Khusus / 17 Kenderaan Pertahanan/ Keselamatan Negara – Kenderaan Bawah 3 Ton / 18 Kenderaan Pertahanan/ Keselamatan Negara – Kenderaan Melebihi 3 Ton / 19 Kenderaan Pertahanan/ Keselamatan Negara – Jentera Berat / 20 Kenderaan Pertahanan/ Keselamatan Negara – Kerja-Kerja Khusus (Baikpulih Enjin) / 21 Kenderaan Pertahanan/ Keselamatan Negara – Kerja-kerja Mengetuk dan Mengecat / 22 Kenderaan Pertahanan/ Keselamatan Negara – Alat Hawa Dingin Kenderaan / 23 Kenderaan Pertahanan/ Keselamatan Negara – Membaik Pulih Tempat Duduk/ Kusyen dan Bumbung / 24 Kenderaan Pertahanan/ Keselamatan Negara – Kerja-Kerja Penyelenggaraan Sistem Kenderaan
  02 Penyelenggaraan/ Pembaikan Mesin, Perabot Pejabat/ Kediaman: 01 Mesin-Mesin Pejabat/ Kediaman / 02 Perabot Pejabat/ Kediaman / 03 Alat Muzik, Kesenian Dan Aksesori
  03 Penyelenggaraan/ Pembaikan Alat Hawa Dingin: 01 Alat Hawa Dingin (Window/ Split/ Berpusat)
  04 Penyelenggaraan/ Pembaikan Alat Keselamatan: 01 Alat Kebombaan/ Alat Penyelamat/ Pemadam Api / 02 Peralatan Kawalan Keselamatan / 03 Mesin Pengimbas
  05 Penyelenggaraan/ Pembaikan Kejuruteraan Dan Komunikasi: 01 Alat Semboyan/ Perhubungan/ Penyiaran / 02 Kontena/ Tangki / 03 Perkakas/ Sistem Elektrik / 04 Mesin dan Peralatan Woksyop / 05 Mechanisation System / 06 Membaiki Buff Fuel Tank / 07 Pump/ Paip Air Dan Komponen / 08 Baikpulih Barang-Barang Logam / 09 Production Testing, Surface Well Testing and Wire Line Services / 10 Faksimili
  06 Penyelenggaraan/ Pembaikan Peralatan/ Kelengkapan Perubatan dan Makmal: 01 Alat Kelengkapan Perubatan/ Makmal / 02 Mesin Dan Peralatan Makmal
  07 Penyelenggaraan/ Pembaikan Bot/ Kapal, Helikopter, Simulator Dan Pesawat: 01 Bot/ Kapal/ Barge/ Kapal Selam/ Jet Ski/ Sampan / 02 Sand Blasting Dan Mengecat Untuk Kapal / 03 Penyelenggaraan Kapal Terbang / 04 Penyelenggaraan Helikopter / 05 Penyelenggaraan Simulator Kapal / 06 Penyelenggaraan Simulator Kapal Terbang / 07 Penyelenggaraan Simulator Helikopter / 08 Pembaikan Kenderaan Yang Tidak Berenjin / 09 Kerja Pembaikan Kapal Angkasa/ Satelit / 10 Alat-Alat Marin / 11 Kenderaan Pertahanan/ Keselamatan Negara – Bot/ Kapal/ Barge/ Kapal Selam/ Jet Ski / 12 Kenderaan Pertahanan/ Keselamatan Negara – Sand Blasting Dan Mengecat Untuk Kapal / 13 Kenderaan Pertahanan/ Keselamatan Negara – Penyelenggaraan Kapal Terbang / 14 Kenderaan Pertahanan/ Keselamatan Negara – Penyelenggaraan Helikopter
  08 Pertahanan Dan Keselamatan: 01 Kawalan Keselamatan / 02 Penyiasat Persendirian / 03 Penyelenggaraan Dan Pembaikan Senjata / 04 Penyelenggaraan Misil/ Roket Dan Sub Sistem, Pelancar
  09 Pengawalan Dan Pengawasan: 01 Kawalan Serangga Perosak, Anti Termite / 02 Menangkap/ Menembak Haiwan
  10 Khidmat Kebersihan Dan Rawatan: 01 Pembersihan Bangunan Dan Pejabat / 02 Membersih Kawasan / 03 Mengangkat Sampah / 04 Membersih Kenderaan / 05 Mencuci Kolam Renang / 06 Membersih Pantai/ Sungai/ Terusan/ Empangan/ Tasik / 07 Pelupusan Dan Perawatan Sisa Berbahaya / 08 Pelupusan Dan Perawatan Buangan Terjadual / 09 Pelupusan dan Rawatan Sisa Radio Aktif dan Nuklear / 10 Kolam Kumbahan/ Sisa Perawatan/ Talian Paip/ Sesalur / 11 Pembersihan Tumpahan Minyak
  11 Guna Tenaga: 01 Kakitangan Iktisas (Profesional) / 02 Kakitangan Separa Iktisas (Semi Profesional) / 03 Khidmat Guaman / 04 Tenaga Buruh / 05 Pemungut Hutang/ Penghantar Notis / 06 Stevedor / 07 Telly Clerk / 08 Mengikat Dan Melepas Tali Kapal (Mooring) / 09 Menyelam (Diving Service) / 10 Khidmat Latihan, Tenaga Pengajar dan Moderator/ Negotiator / 11 Salvage Boat/ Kapal / 12 Malim Kapal
  12 Khidmat Udara/ Laut/ Darat: 01 Topografi/ LIDAR / 02 Pembajaan/ Pest Control / 03 Cloud Seeding / 04 Hidrografi / 05 Oceanografi / 06 Pemetaan/ Pemetaan Utiliti Bawah Tanah / 07 Geologi
  13 Kesenian, Hiburan Dan Pelancongan: 01 Pengeluaran Filem / 02 Rakaman / 03 Fotografi / 04 Audio Visual / 05 Penyediaan Pentas/ Pameran Pertunjukan, Taman Hiburan Dan Karnival/ Pestaria / 06 Artis Dan Penghibur Profesional / 07 Agen Pengembaraan / 08 Dokumentasi Dan Panduarah / 09 Pemeliharaan Bahan Bahan Sejarah Dan Tempat Bersejarah / 10 Penyimpanan Rekod / 11 Membaikpulih Bahan Terbitan Dan Manuskrip
  14 Pengindahan: 01 Bangunan/ Hiasan Dalaman / 02 Hiasan Jalan/ Kawasan
  15 Penyewaan Dan Pengurusan: 01 Perabot/ Kelengkapan / 02 Mesin dan Peralatan Pejabat / 03 Kenderaan/ Jentera/ Kenderaan Rekreasi / 04 Kapal/ Bot/ Bot Tunda/ Feri/ Bot Malim/ Barge/ Jet Ski/ Kapal Selam / 05 Kapal Terbang/ Helikopter/ Pesawat/ Belon Panas/ Simulator Serta Lain-Lain Kenderaan Udara / 06 Bangunan/ Pejabat/ Stor/ Ruang Niaga/ Rumah Kediaman / 07 Kemudahan Awam/ Sukan / 08 Peralatan/ Kelengkapan Hospital Dan Makmal / 09 Peralatan Keselamatan dan Senjata / 10 Tempat Letak Kereta / 11 P.A Sistem Dan Alat Muzik / 12 Bantuan Kecemasan Dan Ambulans/ Kenderaan Jenazah / 13 Pakaian/ Kelengkapan Dan Aksesori
  16 Percetakan: 01 Mencetak Buku, Majalah, Laporan Akhbar / 02 Mencetak Fail, Kad Perniagaan Dan Kad Ucapan / 03 Mencetak Label, Poster, Pelekat Dan Iron On / 04 Mencetak Label, Poster Dan Pelekat (Plastik) / 05 Mencetak Continuous Stationery Forms / 06 Mencetak Borang/Kertas Komputer / 07 Cetakan Keselamatan / 08 Cetakan Hologram / 09 Pisah Warna (Colour Separation) / 10 Menjilid Kulit Keras / 11 Varnishing / 12 Laminating / 13 Menjilid Kulit Lembut / 14 Pengatur Huruf (Type Setting) / 15 Rekabentuk Percetakan (Printing Design)
  17 Perkhidmatan Pengangkutan, Penyimpanan Dan Pos: 01 Pemilik Kapal / 02 Broker Perkapalan / 03 Agen Perkapalan / 04 Pengangkutan Lori / 05 Agen Penghantaran / 06 Pembungkusan Dan Penyimpanan / 07 Pembungkusan / 08 Penghantaran Dokumen / 09 Multimodal Transport Operator (MTO) / 10 Perkhidmatan Mel Pukal / 11 Pengurusan Pelabuhan / 12 Ship Chandling / 13 Ship Trimming
  18 Perkhidmatan Kewangan Dan Insuran: 01 Syarikat Insuran / 02 Broker Insuran / 03 Penyediaan Akaun Dan Pengauditan / 04 Pengurusan Kewangan Dan Korporat / 05 Pemfaktoran (Dimansuhkan) / 06 Syarikat Pelelong Awam
  19 Barang Lusuh: 01 Membeli Barang Lusuh Tanpa Permit / 02 Membeli Barang Lusuh Perlu Permit
  20 Editorial, Rakbentuk Grafik, Seni Halus Dan Harta Intelek: 01 Media Elektronik / 02 Media Cetak / 03 Bill Board / 04 Penulisan – Semua Jenis Penulisan / 05 Mereka-Cipta Dan Seni Halus / 06 Penterjemahan / 07 Pengkomersilan / 08 Hak Harta Intelek (Patent) / 09 Lain-lain Media Media Pengiklanan / 10 Perkhidmatan Fotostat
  21 Perkhidmatan Perladangan/ Perikanan/ Haiwan Dan Hidupan Liar: 01 Perikanan Dan Akuakultur / 02 Hortikultur / 03 Ternakan / 04 Pertanian/ Tanaman/ Ladang/ Taman/ Hutan Dan Ladang Hutan / 05 Rawatan Hutan / 06 Sumber Air / 07 Tatahias Haiwan / 08 Tukun Tiruan
  22 Perkhidmatan Hal Ehwal Sosial Dan Politik: 01 Hubungan Antarabangsa / 02 Bantuan Kemanusiaan / 03 Dasar Dan Peraturan
  23 Perkhidmatan Domestik: 01 Solekan / 02 Dobi / 03 Membekal Air / 04 Pengurusan Jenazah Dan Kelengkapan / 05 Mengangkut Mayat
  24 Perkhidmatan Menjahit Dan Baik Pulih: 01 Menjahit Pakaian Dan Kelengkapan / 02 Menjahit Bukan Pakaian / 03 Baik Pulih Kasut Dan Barangan Kulit / 04 Barangan PVC/ Kanvas / 05 Barangan Logam
  25 Hotel, Rumah Tumpangan Dan Pusat Latihan: 01 Hotel/ Resort / 02 Motel/ Chalet/ Rumah Tumpangan / 03 Homestay / 04 Pusat Latihan
  26 Perkhidmatan Kejuruteraan Elektrik Dan Elektronik: 01 Akustik Dan Gelombang / 02 Pencahayaan (Illumination)
  27 Perkhidmatan Lain-lain: 01 Pengurusan Telekomunikasi / 02 Marker/ DNA / 03 Bioteknologi / 04 Pensijilan Dan Pengiktirafan / 05 Ujian Makmal / 06 Kodifikasi / 07 Perkhidmatan Perubatan - Dialisis
  28 Perkidmatan Teknologi Hijau: 01 Teknologi Hijau
  29 Seni Ukir: 01 Ukiran Berasaskan Kayu
```

(Regulatory/license parenthetical notes shown in the source PDF, e.g. "Perlu Lesen KDN,"
were trimmed from several long entries above for readability of this appendix; the actual
`shared/src/fieldCodes.ts` data file written during implementation should preserve them in
full as the `name` string, since they're meaningful label text, not filter logic.)
