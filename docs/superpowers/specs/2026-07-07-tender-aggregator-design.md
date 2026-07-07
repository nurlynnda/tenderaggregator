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
| Main page features | Text search, filters (ministry/agency/category/source/open-closed), sorting. No stats bar. |
| Language | TypeScript everywhere. |
| TDD enforcement | Husky pre-commit runs tests; Vitest coverage thresholds (80% lines/branches); CLAUDE.md mandates test-first. No CI. |
| Scrape UX | Backend scrape-status endpoint; frontend progress banner, rescrape button disabled while running. |
| Architecture | Monorepo, npm workspaces: `shared/`, `backend/`, `frontend/`. Docker Compose with two services. |
| Styling | Tailwind CSS. |

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
  ministry: string | null,
  agency: string | null,
  category: string | null,        // Kategori Perolehan
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
dates/prices normalized for uniform sort/filter across sources.

## Backend (Express + TypeScript)

### Scraper adapters

- Interface: `ScraperAdapter { name: string; scrape(onProgress): Promise<Tender[]> }`.
- `MyProcurementAdapter`:
  - `GET /procurements/fetch?page=N&itemsPerPage=100`; first call reads `total` and
    `lastPage`, then loops through all pages.
  - Parses the `html` response field with cheerio. Per tender card: sourceId from the
    `select-procurement` dispatch, reference no., title + href, label/value rows
    (Kementerian, Agensi, Kategori Perolehan, Kod Bidang, Tarikh Tutup Pelawaan,
    Harga Indikatif Jabatan), Tarikh Pelawaan badge, and the desktop `<table>` of events.
  - dd/mm/yyyy → ISO; "RM 28,800.00" → 28800; HTML entities decoded.
  - Politeness: ~300ms between pages; retry w/ backoff, 3 attempts/page; a page that
    still fails aborts the run with status `failed` (no partial dataset stored).
  - Each record Zod-validated; invalid records logged and skipped.

### Storage

- `data/<source>/tenders.json` (array) + `data/<source>/meta.json`
  (`{ lastScrapedAt, total }`).
- Repository module: upsert-by-id merge preserving delisted tenders; atomic writes
  (temp file + rename).

### Startup

On boot, for each registered adapter with no `data/<source>/tenders.json`, start a
background scrape. Server serves immediately regardless.

### API

- `GET /api/tenders` — `search`, `ministry`, `agency`, `category`, `source`,
  `status` (open|closed relative to today), `sortBy`
  (advertisedDate|closingDate|indicativePrice), `sortOrder`, `page`, `pageSize` →
  `{ items, total, page, pageSize }`. Filtering/sorting server-side.
- `GET /api/tenders/facets` — distinct ministries/agencies/categories/sources.
- `GET /api/tenders/:id` — single tender.
- `POST /api/scrape` — rescrape all sources; 409 if running.
- `GET /api/scrape/status` — `{ state: idle|running|done|failed, source, currentPage, lastPage, error? }`.

## Frontend (React + Vite + Tailwind + React Query)

- **Main page `/`** — table (title, referenceNo, ministry, agency, category, closingDate,
  indicativePrice, source); debounced search box; filter dropdowns fed by facets endpoint;
  sortable columns; server-side pagination; row click → detail page.
- **Detail page `/tenders/:id`** — all schema fields, events table, prominent link to
  `sourceUrl`. Layout leaves room for future on-demand enrichment.
- **Scrape UX** — header Rescrape button; polls `/api/scrape/status` every ~2s while
  running; progress banner "Scraping MyProcurement — page 12/56"; button disabled while
  running; list refreshes on completion; error shown on failure.
- Data layer: small typed API client + React Query. No other state library.

## Docker

- `backend`: node:22-alpine, port 3001, volume `./backend/data:/app/data`.
- `frontend`: multi-stage build → nginx on port 8080, proxies `/api` to backend.
- `docker compose up` runs everything.

## Testing / TDD

- Vitest in all three workspaces.
- Backend: parser unit tests against a saved fixture of the real sample response
  (core of the work); date/price parsing; repository upsert + atomic write; supertest
  route tests with mocked fetch (tests never hit the real site).
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
