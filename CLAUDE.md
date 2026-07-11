# tms-v2 — Malaysia Tender Aggregator

Consolidates publicly available Malaysian government tenders from multiple sources
(currently MyProcurement) into one searchable web app.

## Communication style
Always explain things in plain, layman's terms — no unexplained jargon, acronyms, or
technical shorthand. This applies everywhere: brainstorming/design discussions, plan
summaries, code walkthroughs, error explanations, everything. If a technical term is
unavoidable, briefly say what it means in the same breath.

## Stack
- npm workspaces monorepo: `shared/` (Zod tender schema), `backend/` (Express + scrapers,
  JSON-file storage in `backend/data/`), `frontend/` (React + Vite + Tailwind).
- Node 24, TypeScript, ESM everywhere.

## Commands
- `npm test` — run all workspace test suites (also runs on pre-commit via husky)
- `npm run dev -w backend` — backend on :3001
- `npm run dev -w frontend` — frontend on :5173 (proxies /api to :3001)
- `docker compose up --build` — full stack, frontend on :8080

## TDD — non-negotiable
1. Write the failing test FIRST. Run it. Confirm it fails for the right reason.
2. Write the minimal implementation. Run the test. Confirm it passes.
3. Commit immediately after green. Never commit red.
4. Coverage thresholds (80% lines/branches) are enforced by vitest; pre-commit runs the
   full suite. Do not lower thresholds or skip hooks.
5. Tests must NEVER hit the real myprocurement.treasury.gov.my. Use fixtures in
   `backend/test/fixtures/` and injected fakes.

## Key design rules (see docs/superpowers/specs/2026-07-07-tender-aggregator-design.md)
- All scrapers emit the shared `Tender` schema (`shared/src/tender.ts`). Zod-validate
  every record; invalid records are logged and skipped, never stored.
- MyProcurement requires explicit `type` + `category` params — 6 job combinations.
  Archive categories use the `advertisement-` prefix.
- Rescrape button = open jobs only. Archive backfill = once, at startup, resumable.
- Rate limiting: serial requests, delay + jitter, backoff, honor Retry-After.
- Cross-source dedup by `dedupKey` (normalized referenceNo) at query time.

## Adding a new data source
1. Create `backend/src/scrapers/<source>/adapter.ts` implementing `ScraperAdapter`
   (`backend/src/scrapers/types.ts`).
2. Emit `Tender` records with `source: '<source>'`, `id: '<source>:<sourceId>'`,
   `dedupKey: computeDedupKey(referenceNo, id)`.
3. Register it in the adapters array in `backend/src/index.ts`.
4. Fixture-based parser tests first, adapter tests with fake fetcher second.
