# Malaysia Tender Aggregator — Design

**Date:** 2026-07-07
**Status:** Approved by user

## Purpose

A website that consolidates publicly available Malaysian government tenders from multiple
data sources into one searchable interface. First data source: MyProcurement
(myprocurement.treasury.gov.my). The architecture must make adding future sources cheap:
one adapter file emitting a shared standardized schema.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Scrape depth | List data only. Keep `sourceUrl` per tender so per-tender detail pages can be scraped **on demand later** — design must not block this. |
| Rescrape reconciliation | Upsert by ID, keep tenders that disappear from the source (historical archive grows). |
| Open vs archive coverage | MyProcurement requires **both** `type` and `category` params (verified against the live API — see "MyProcurement API verified behavior" below). Startup scrape covers all 6 jobs (open + archive × 3 categories, ~134k records total). The manual Rescrape button only re-crawls the 3 **open** categories (~5,775 records); the archive backfill is a one-time startup job, not part of the repeated rescrape cycle. |
| Main page features | Text search, filters (ministry/agency/category/source/open-closed), sorting. No stats bar. |
| Language | TypeScript everywhere. |
| TDD enforcement | Husky pre-commit runs tests; Vitest coverage thresholds (80% lines/branches); CLAUDE.md mandates test-first. No CI. |
| Scrape UX | Backend scrape-status endpoint; frontend progress banner, rescrape button disabled while running. |
| Architecture | Monorepo, npm workspaces: `shared/`, `backend/`, `frontend/`. Docker Compose with two services. |
| Styling | Tailwind CSS. |

## MyProcurement API verified behavior

Verified directly against the live endpoint (2026-07-07) — this supersedes any assumption
that `category`/`type` are optional:

- **Without `category`**, the endpoint silently defaults to `category=quotation` only.
  Confirmed by scanning all 58 pages of the no-param response: every single item was a
  quotation. The `total` field in that response is misleading — it reports 5,775 (the
  combined count across all three categories) even though the actual returned items are
  100% quotations. **`category` must always be passed explicitly.**
- **`type=advertisements`** (open/ongoing tenders) uses category values `quotation`,
  `tender`, `requisition`.
- **`type=archive`** (closed tenders) uses **different** category values:
  `advertisement-quotation`, `advertisement-tender`, `advertisement-requisition`.
  Passing the plain category name (e.g. `category=quotation`) with `type=archive` returns
  `{"error":"Invalid category format"}`. Confirmed by extracting the actual frontend JS
  (`loadTable()`) from the live page source, which sets these exact param pairs.
- Measured totals (2026-07-07):

  | type | category | total | lastPage |
  |---|---|---|---|
  | advertisements | quotation | 4,803 | 481 |
  | advertisements | tender | 952 | 96 |
  | advertisements | requisition | 20 | 2 |
  | archive | advertisement-quotation | 103,957 | 10,396 |
  | archive | advertisement-tender | 23,423 | 2,343 |
  | archive | advertisement-requisition | 497 | 50 |

- The adapter therefore runs **6 crawl jobs** (3 categories × 2 types), not one. Each job
  is paginated independently using that job's own `lastPage`.
- `itemsPerPage` appears server-capped at 100 regardless of the requested value.

## Architecture

npm workspaces monorepo:

```
tms-v2/
├── shared/      # Zod tender schema + inferred TS types (single source of truth)
├── backend/     # Express API + scraper adapters + JSON-file repository
│   └── data/    # JSON storage (gitignored, volume-mounted in docker)
├── frontend/    # React + Vite + Tailwind + React Query
├── docker-compose.yml
├── CLAUDE.md
└── README.md
```

## Standardized tender schema (shared/, Zod)

```ts
Tender = {
  id: string,              // "<source>:<sourceId>" — globally unique, drives upsert
  source: string,          // "myprocurement"
  sourceId: string,        // native ID (from the select-procurement dispatch id)
  referenceNo: string,     // No. Sebut Harga
  title: string,           // HTML entities decoded
  sourceUrl: string,       // official detail page link (basis for future on-demand detail scrape)
  status: "open" | "closed",              // derived from the job's type (advertisements/archive)
  procurementType: "quotation" | "tender" | "requisition",  // normalized job category
  ministry: string | null,
  agency: string | null,
  category: string | null,        // Kategori Perolehan (free-text label from the page, distinct from procurementType)
  fieldCodes: string[],           // Kod Bidang split on commas
  advertisedDate: string | null,  // ISO 8601 date (from dd/mm/yyyy Tarikh Pelawaan)
  closingDate: string | null,     // ISO 8601 date (Tarikh Tutup Pelawaan)
  indicativePrice: number | null, // parsed from "RM 28,800.00"
  currency: "MYR",
  events: Array<{ label: string, date: string | null, address: string | null }>,
                                  // Lawatan Tapak / Taklimat table rows
  raw: Record<string, string>,    // verbatim source fields (incl. original price string)
  scrapedAt: string,              // ISO timestamp
}
```

Principles: nothing from a source is dropped (`events` + `raw` catch everything);
dates/prices normalized for uniform sort/filter across sources. `status` and
`procurementType` are set by the adapter from which of the 6 jobs produced the record
(not parsed from page content), so they are reliable even though the source's own
`Kategori Perolehan` free-text field is inconsistent (e.g. "Perkhidmatan Bukan
Perunding" vs "Bekalan" vs "Kerja" don't map 1:1 to quotation/tender/requisition).

## Backend (Express + TypeScript)

### Scraper adapters

- Interface: `ScraperAdapter { name: string; scrape(onProgress): Promise<Tender[]> }`.
- `MyProcurementAdapter` runs **6 jobs**, one per `(type, category)` pair:

  | job status | job procurementType | type param | category param |
  |---|---|---|---|
  | open | quotation | `advertisements` | `quotation` |
  | open | tender | `advertisements` | `tender` |
  | open | requisition | `advertisements` | `requisition` |
  | closed | quotation | `archive` | `advertisement-quotation` |
  | closed | tender | `archive` | `advertisement-tender` |
  | closed | requisition | `archive` | `advertisement-requisition` |

  For each job: `GET /procurements/fetch?page=N&itemsPerPage=100&type=<type>&category=<category>`;
  first call reads `total`/`lastPage` for that job, then loops through all of that job's
  pages. `category` and `type` are always passed explicitly — omitting `category` causes
  the API to silently default to open quotations only while still reporting a misleading
  combined `total`.
  - Parses the `html` response field with cheerio. Per tender card: sourceId from the
    `select-procurement` dispatch, reference no., title + href, label/value rows
    (Kementerian, Agensi, Kategori Perolehan, Kod Bidang, Tarikh Tutup Pelawaan,
    Harga Indikatif Jabatan), Tarikh Pelawaan badge, and the desktop `<table>` of events.
  - dd/mm/yyyy → ISO; "RM 28,800.00" → 28800; HTML entities decoded.
  - Politeness: ~300ms between pages; retry w/ backoff, 3 attempts/page; a page that
    still fails aborts **that job** with status `failed` (other jobs / previously
    completed jobs are unaffected; no partial job dataset is stored).
  - Each record Zod-validated; invalid records logged and skipped.

- **Startup scrape** (first run only, no existing data): runs all 6 jobs — open
  (~5,775 records) and archive (~128k records, ~12,789 pages combined). This is a
  one-time backfill; expect it to take a while and run fully in the background while the
  server already serves whatever's scraped so far.
- **Rescrape button** (`POST /api/scrape`): runs only the 3 **open** jobs. Archive data is
  effectively static (closed tenders don't change) and is not part of the repeated
  rescrape cycle, keeping manual rescrapes fast (~5,775 records instead of ~134k).

### Storage

- `data/<source>/tenders.json` (array) + `data/<source>/meta.json`
  (`{ lastScrapedAt, lastArchiveBackfillAt: string | null, total }`).
  `lastArchiveBackfillAt` tracks whether the one-time archive backfill has run, so startup
  knows not to repeat it.
- Repository module: upsert-by-id merge preserving delisted tenders; atomic writes
  (temp file + rename). Given the archive backfill's scale (~128k records), the repo
  batches writes rather than rewriting the whole file per record.

### Startup

On boot, for each registered adapter with no `data/<source>/tenders.json`, start a
background scrape covering **all 6 jobs** (open + archive backfill) and record
`lastArchiveBackfillAt` on completion. If `tenders.json` already exists but
`lastArchiveBackfillAt` is unset (e.g. a prior run was interrupted before finishing),
resume by running the archive backfill jobs only. Server serves immediately regardless.

### API

- `GET /api/tenders` — `search`, `ministry`, `agency`, `category`, `source`,
  `status` (open|closed), `procurementType` (quotation|tender|requisition), `sortBy`
  (advertisedDate|closingDate|indicativePrice), `sortOrder`, `page`, `pageSize` →
  `{ items, total, page, pageSize }`. Filtering/sorting server-side.
- `GET /api/tenders/facets` — distinct ministries/agencies/categories/sources/procurementTypes.
- `GET /api/tenders/:id` — single tender.
- `POST /api/scrape` — rescrape all sources' **open** jobs only; 409 if a scrape is
  already running. (Archive backfill is not re-triggered by this endpoint — see Startup.)
- `GET /api/scrape/status` — `{ state: idle|running|done|failed, source, job,
  jobsCompleted, jobsTotal, currentPage, lastPage, error? }`. `job` identifies which of the
  (up to 6) jobs is currently running so the frontend can show e.g. "Scraping MyProcurement
  — open tenders, tender category — page 12/96".

## Frontend (React + Vite + Tailwind + React Query)

- **Main page `/`** — table (title, referenceNo, ministry, agency, category, status,
  procurementType, closingDate, indicativePrice, source); debounced search box; filter
  dropdowns fed by facets endpoint (including status open/closed and procurementType);
  sortable columns; server-side pagination; row click → detail page.
- **Detail page `/tenders/:id`** — all schema fields, events table, prominent link to
  `sourceUrl`. Layout leaves room for future on-demand enrichment.
- **Scrape UX** — header Rescrape button (rescrapes open tenders only, per design);
  polls `/api/scrape/status` every ~2s while running; progress banner e.g. "Scraping
  MyProcurement — tender category, page 12/96 (job 2/3)"; button disabled while running;
  list refreshes on completion; error shown on failure. First-run archive backfill shows
  the same banner style but is not user-triggerable.
- Data layer: small typed API client + React Query. No other state library.

## Docker

- `backend`: node:22-alpine, port 3001, volume `./backend/data:/app/data`.
- `frontend`: multi-stage build → nginx on port 8080, proxies `/api` to backend.
- `docker compose up` runs everything.

## Testing / TDD

- Vitest in all three workspaces.
- Backend: parser unit tests against saved fixtures of real responses — the quotation
  sample already captured, plus small tender/requisition/archive fixtures (to cover the
  `advertisement-*` category markup and confirm `status`/`procurementType` tagging);
  date/price parsing; repository upsert + atomic write at scale (batch write test with a
  large synthetic dataset given the ~128k-record archive); adapter test asserting all 6
  `(type, category)` job param combinations are used; supertest route tests with mocked
  fetch (tests never hit the real site).
- Frontend: React Testing Library + MSW.
- Shared: schema validation tests.
- Enforcement: husky pre-commit runs the full suite; coverage thresholds 80%
  lines/branches; CLAUDE.md mandates red-green-refactor.

## Error handling summary

- Network/page failures: retry ×3 with backoff, then abort run as `failed` (surfaced in
  status endpoint and frontend banner). Existing data untouched.
- Parse failures on individual tenders: log + skip, never store invalid records.
- Concurrent scrape requests: 409.
- Crash-safe storage via atomic writes.

## Out of scope (this iteration)

- Scraping per-tender detail pages (planned later, on demand from the detail page).
- Additional data sources (architecture ready; only MyProcurement implemented).
- Scheduled/automatic rescrapes, auth, stats bar, CI pipeline.
