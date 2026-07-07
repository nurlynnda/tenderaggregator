# Malaysia Tender Aggregator

Consolidates publicly available Malaysian government tenders into one searchable
web app. Currently scrapes [MyProcurement](https://myprocurement.treasury.gov.my)
(open + archived tenders across quotation/tender/requisition categories); the
architecture supports adding more sources as pluggable adapters emitting one
standardized schema.

## Quick start (Docker)

    docker compose up --build

- App: http://localhost:8080
- API: http://localhost:3001/api

On first start the backend scrapes all sources in the background (open tenders
first-class, plus a one-time archive backfill of ~128k closed tenders — this takes
a while; the app is usable immediately and fills in as pages arrive). Data persists
in `backend/data/` between restarts; the backfill resumes if interrupted.

## Development

    npm install
    npm run dev -w backend    # Express API on :3001
    npm run dev -w frontend   # Vite dev server on :5173 (proxies /api)

## Testing

    npm test                  # all workspaces; also runs on every commit (husky)

TDD is enforced: pre-commit runs the full suite, and vitest enforces 80%
line/branch coverage per workspace. See CLAUDE.md for the workflow rules.

## API

| Route | Description |
|---|---|
| `GET /api/tenders` | List tenders. Query params: `search`, `ministry`, `agency`, `category`, `source`, `status` (open/closed), `procurementType` (quotation/tender/requisition), `sortBy` (advertisedDate/closingDate/indicativePrice), `sortOrder`, `page`, `pageSize` (max 100) |
| `GET /api/tenders/facets` | Distinct filter values |
| `GET /api/tenders/:id` | One tender + same-tender records from other sources |
| `POST /api/scrape` | Rescrape open tenders from all sources (409 if already running) |
| `GET /api/scrape/status` | Scrape progress: state, job, page x of y |
| `GET /api/health` | Liveness |

## Architecture

- `shared/` — Zod `Tender` schema: the standardized model every scraper must emit.
- `backend/` — Express API; scraper adapters (`src/scrapers/`); JSON-file storage in
  `data/<source>/` with atomic writes; scrape orchestration with per-page progress.
- `frontend/` — React + Vite + Tailwind; list page (search/filter/sort/paginate),
  detail page, scrape progress banner.

Cross-source duplicates are collapsed at query time by normalized tender number
(`dedupKey`); every source's record is preserved and surfaced on the detail page.

Scraping is polite: serial requests, 300ms+jitter delay (`SCRAPE_DELAY_MS` to tune),
exponential backoff, `Retry-After` honored on 429/503, identifying User-Agent.

## Adding a data source

See CLAUDE.md ("Adding a new data source").
