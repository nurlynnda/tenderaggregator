# SPAN Tender Data Source — Design

**Date:** 2026-07-09
**Status:** Approved by user

## Purpose

Add a second tender data source: SPAN (Suruhanjaya Perkhidmatan Air Negara,
[span.gov.my/tender](https://www.span.gov.my/tender)), Malaysia's national water services
regulator. Unlike MyProcurement, SPAN exposes no JSON API — its tender listing is
server-rendered HTML meant for browsers. This adapter must fit the existing
`ScraperAdapter` interface and standardized `Tender` schema, and must never let
cross-source merges overwrite a field one source knows with "unknown" from another.

## Site structure (verified 2026-07-09)

- `GET https://www.span.gov.my/tender/<year>` returns **all** tenders for that year in a
  single HTML response — confirmed no pagination on both the current year (2026, ~20
  entries) and a past year (2023, 16 entries).
- A sidebar (`ul.container__left-menu`) lists available years as links: 2017–2026,
  current year first. `/tender` with no year redirects to the current year.
- Each tender is one block:
  ```html
  <div class="table-listing">
    <a href="https://www.span.gov.my/tender/view/188">
      <h3>SPAN/BKP/PROC/STM/26(8)</h3>
      CADANGAN UNTUK MELANTIK PERUNDING ... SECARA SEBUT HARGA TERBUKA<br>
      Tarikh Iklan 2026-06-22<br>
      Tarikh Tutup 2026-07-06 12:00PM<br>
      Maklumat Sebutharga:
      <span class="badge badge-warning">Diiklankan</span>
    </a>
  </div>
  ```
  - Reference no.: `<h3>` text.
  - Title: text between `</h3>` and the first `<br>`.
  - `sourceId`: numeric id in the `/tender/view/<id>` URL; `sourceUrl` is that same
    absolute URL.
  - Advertised date (`Tarikh Iklan`) and closing date+time (`Tarikh Tutup`) are already
    `YYYY-MM-DD` (closing date has a trailing time like `12:00PM`, which we drop —
    schema stores date only, matching MyProcurement's granularity).
  - Status badge text: `Diiklankan` (advertised/open), `Selesai` (completed), `Dibatalkan`
    (cancelled). No separate class distinguishes `Diiklankan` from `Dibatalkan` (both
    `badge-warning`) — badge **text** is the only reliable signal.
- The detail page (`/tender/view/:id`) is unstructured Word-pasted HTML (`MsoNormal`
  spans, no consistent structure) — no reliably parseable fields beyond what the listing
  already has. Per the existing design's "list data only, detail scraped on demand later"
  principle, this adapter scrapes **listing pages only**.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Cancelled tenders (`Dibatalkan`) | Stored with `status: 'closed'`, original badge text preserved in `raw`. Nothing from a source is dropped. |
| Unclassifiable `procurementType` | Stored with `procurementType: null` rather than skipped — user wants these tenders visible even when the type can't be inferred from title wording. |
| Job model | Current year = **open job**, rescraped every time (statuses there still change). All earlier years down to 2017 = **archive jobs**, backfilled once at startup, never rescraped (matches "archive data is effectively static" from the original design). |
| Scrape depth | Listing pages only, same as MyProcurement's current scope. Detail-page enrichment is future/out-of-scope work for both sources. |

## Schema change: `procurementType` becomes nullable

`shared/src/tender.ts`: `procurementType` changes from
`z.enum(['quotation', 'tender', 'requisition'])` to the same enum `.nullable()`, on both
`TenderSchema` and `TenderPatchSchema`. This is required because SPAN has no structured
type field — it's inferred from title wording, and inference sometimes fails.

**Cross-source overwrite safety** (the user's core requirement — "not overwritten, only
upserted"): `backend/src/storage/repository.ts`'s `NULLABLE_FIELDS` set (which makes a
patch's `null` mean "no information, don't clobber a known value") gets `'procurementType'`
added to it. Without this, a `null` patch value falls through to the generic
last-write-wins path and would overwrite a real type already established by another
source's patch for the same `dedupKey`.

The same overwrite-safety concern applies to fields SPAN never observes at all
(`category`, `fieldCodes`, `indicativePrice`, `events`, `winners`): the adapter omits
these keys from the patch entirely (leaves them `undefined`) rather than sending
`null`/`[]`. This matters most for `fieldCodes`/`events`/`winners`, which are arrays *not*
covered by `NULLABLE_FIELDS` — an explicit `[]` would actively erase data another source
already contributed for the same `dedupKey`, whereas an omitted key is a no-op in
`mergeOne()`'s `value === undefined` guard.

**Frontend fallout** (both purely cosmetic, no logic change needed elsewhere —
`buildFacets`/`queryTenders` already handle `string | null` via the existing `distinct()`
helper):
- `frontend/src/pages/TenderListPage.tsx:144`: render `t.procurementType ?? '—'`.
- `frontend/src/pages/DetailPage.tsx:49`: same null fallback, styled consistently with
  the other nullable `Field` rows.

## Field mapping (`backend/src/scrapers/span/parseListing.ts`)

| Tender field | Source | Notes |
|---|---|---|
| `referenceNo` | `<h3>` text | |
| `title` | text between `</h3>` and first `<br>` | whitespace-collapsed |
| `sourceId` / `sourceUrl` | `/tender/view/<id>` link | `sourceUrl` already absolute |
| `status` | badge text | `Diiklankan` → `open`; `Selesai`/`Dibatalkan` → `closed` |
| `procurementType` | keyword match in title: `/TENDER/i` → `tender`, `/SEBUT\s*HARGA/i` → `quotation` | `null` if neither matches |
| `advertisedDate` | `Tarikh Iklan` value | new helper for already-ISO `YYYY-MM-DD`, distinct from MyProcurement's `dd/mm/yyyy` parser |
| `closingDate` | `Tarikh Tutup` value, date portion only | same helper, time-of-day dropped |
| `ministry` | — | omitted (not present on this source) |
| `agency` | fixed `"Suruhanjaya Perkhidmatan Air Negara (SPAN)"` | SPAN is always its own agency |
| `category`, `fieldCodes`, `indicativePrice`, `events`, `winners` | — | omitted (not structurally available from listing pages) |
| `raw` | reference no., title, `Tarikh Iklan`, `Tarikh Tutup`, badge text | verbatim |
| `dedupKey` | `computeDedupKey(referenceNo, fallback)`, `fallback = `span:${sourceId}`` | reused as-is from `shared/src/tender.ts` — this is what makes cross-source dedup with MyProcurement work automatically |
| `source` | `{ source: 'span', sourceId, sourceUrl }` | |

A block missing a parseable id, title, or reference number is skipped and logged,
matching MyProcurement's parser behavior.

## Fetching & rate limiting

SPAN returns HTML, not JSON. `backend/src/http/politeFetch.ts`'s `createPoliteFetcher`
currently hardcodes `Accept: application/json` and `res.json()`. It gains a
`responseType: 'json' | 'text'` option (default `'json'`, preserving MyProcurement's
existing behavior untouched) that switches the `Accept` header and the response parse
step. The delay/jitter/retry/backoff/`Retry-After` logic is shared, not duplicated.

## Job model detail (`backend/src/scrapers/span/adapter.ts`)

- `SPAN_JOBS`: generated at construction time from `MIN_YEAR = 2017` through
  `new Date().getFullYear()` (so the current-year boundary rolls forward automatically
  on each server run) — `{ year, status: year === currentYear ? 'open' : 'closed' }`,
  current year first.
- Job name: `` `${status}-${year}` `` (e.g. `open-2026`, `closed-2025`).
- `archiveJobNames()` → job names for every non-current year.
- One page fetch per job (no pagination within a year).

## Wiring

- New files: `backend/src/scrapers/span/adapter.ts`, `backend/src/scrapers/span/parseListing.ts`.
- `backend/src/index.ts`: register `new SpanAdapter(createPoliteFetcher({ responseType: 'text' }))`
  alongside the existing `MyProcurementAdapter`.
- No repository changes beyond the `NULLABLE_FIELDS` addition — upsert-by-`sourceId`
  (within-source) and dedup-by-`dedupKey` (cross-source) already work unmodified for a
  second source.

## Testing / TDD

- `backend/test/fixtures/span-2026.html`: trimmed real fixture covering open
  (`Diiklankan`), completed (`Selesai`), and cancelled (`Dibatalkan`) badges; one
  tender-keyword title, one quotation-keyword title, one with neither keyword (→ `null`
  type).
- Parser unit tests: field extraction, ISO date-prefix parsing, status mapping,
  procurementType inference including the `null` fallback, skip-on-unparseable-block.
- Adapter tests (mirroring `adapter.test.ts`'s structure for MyProcurement): `scope=open`
  hits only the current year; `scope=archive` hits all prior years; `scope=all` hits
  every year; job naming; `archiveJobNames()`; progress/`onJobDone`/`skipJobNames`
  behavior.
- `politeFetch.test.ts`: extend for `responseType: 'text'` (text body, `Accept: text/html`);
  confirm existing JSON-mode tests are unaffected.
- Repository test: merge a `myprocurement` patch and a `span` patch sharing the same
  `dedupKey` (both orderings), asserting no field is clobbered — specifically that
  `procurementType: null` never overwrites a known type, and that omitted
  `fieldCodes`/`winners` never erase values already present from the other source. This
  is the concrete test for the "not overwritten, only upserted" requirement.
- Shared schema test: `procurementType: null` validates on both `TenderSchema` and
  `TenderPatchSchema`.
- Frontend: existing RTL tests updated for the `'—'` fallback on null `procurementType`.

## Out of scope (this iteration)

- Scraping SPAN's per-tender detail pages (unstructured HTML; same "on demand later"
  deferral as MyProcurement).
- `fieldCodes`, `indicativePrice`, `events`, `winners` for SPAN records — not available
  from listing pages.
- Any other new data sources.
