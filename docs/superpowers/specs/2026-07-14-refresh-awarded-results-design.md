# Refresh Awarded Results — Design

**Date:** 2026-07-14
**Status:** Approved by user

## Problem

Awarded/winner data is only ever scraped once, during the initial archive backfill.
Once a source's closed/archive jobs are marked complete
(`completedArchiveJobs` in `<source>/meta.json`), nothing ever re-runs them — not the
"Rescrape" button (open jobs only), not the existing per-source "Full refresh" button
(it still honors the same skip-completed-jobs logic regardless of scope), and not the
daily 12:01pm cron (open-only, MyProcurement-only, per
[2026-07-11-daily-close-and-rescrape-cron-design.md](2026-07-11-daily-close-and-rescrape-cron-design.md)).

So a tender that closes and gets awarded today never shows up as "Awarded" in the app
on its own. Today this was worked around by manually editing
`backend/data/myprocurement/meta.json` to strip the completed-archive markers for the
results jobs and restarting the container — a real capability the app should expose
properly instead of a hand-edited file.

## Investigation findings (2026-07-14, live site)

Before designing, two live checks against `myprocurement.treasury.gov.my` (single
lightweight requests, not a scrape) established what's actually possible:

- **No per-tender "check just this one" option for MyProcurement.** Unlike SPAN (whose
  own tender detail page shows that tender's winner — see
  [2026-07-11-span-detail-winner-scraping-design.md](2026-07-11-span-detail-winner-scraping-design.md)),
  MyProcurement's individual advertisement detail page (`/advertisements/.../<hash>`)
  does not show that tender's award result — its "Keputusan" (results) section is an
  unrelated Alpine.js search widget, not per-tender data. Fetched and inspected one real
  detail page to confirm.
- **Winner data only comes from the bulk `results-quotation` / `results-tender` archive
  categories**, and they're large: `results-quotation` alone reported `lastPage: 1178`
  (at 100 items/page) when queried live. There is no date or sort query parameter
  discovered on the `/procurements/fetch` endpoint, so there's no way to ask the site
  for only new/updated results — any refresh means re-crawling the whole category from
  page 1.
- Incidentally noticed **~40,895 closed quotation/tender tenders currently have
  `winners: null`**. Unknown whether this is a real gap or simply tenders with no
  published result (both are valid outcomes the existing parser already distinguishes —
  see the "postponed"/"no result" cases in the SPAN design doc, same pattern applies
  here). Not investigated further — out of scope for this feature; a refresh naturally
  re-checks all of them regardless.

**Conclusion:** there is no cheap incremental option for MyProcurement. The only
mechanism to pick up new awards is a full re-crawl of the results categories
specifically (not the whole archive — the advertisement-* categories don't need
re-running). KWSP's own "results" job is cheap by contrast (a single page fetch, no
pagination — see `backend/src/scrapers/kwsp/adapter.ts`). SPAN's winners are fetched
inline as part of its normal closed-tender job (one detail-page request per closed
tender in that job), not as a separate results job — there's nothing to selectively
refresh there without re-running the whole job.

## Decision (from brainstorming)

| Topic | Decision |
|---|---|
| What the feature is | An on-demand "Refresh awarded results" action per source — not an automatic daily re-crawl (would run a ~1,178+ page crawl every day for no reason most days) and not further live-site investigation (already established there's no cheaper option). |
| Which sources get the button | MyProcurement and KWSP. Not SPAN — its winners are bundled into its normal closed-tender job with no separate results job to selectively clear; refreshing it would mean a full closed-tender re-run, a different and heavier tradeoff left out of this iteration. |
| Scope of the re-run | Only the source's *results* jobs (MyProcurement: `closed-quotation-results`, `closed-tender-results`; KWSP: `results`), not the whole archive — the advertisement/listing categories stay marked complete and are skipped, same as today. |

## Architecture

No new scraping mechanism. This reuses the existing `archive`-scope scrape pipeline
(pagination, rate limiting via the shared `politeFetch`, resumability, progress
reporting, flush cadence) entirely unchanged. The only new piece is a way to
selectively "un-complete" specific archive job names so the existing
skip-already-completed-job logic in each adapter's `scrape()` lets them run again —
replacing today's manual `meta.json` edit with a real, tested code path.

## Components

### `backend/src/scrapers/types.ts` — `ScraperAdapter` interface

Add `resultsJobNames(): string[]` — the subset of `archiveJobNames()` that specifically
carries award/winner data for this source. Mirrors the existing `archiveJobNames()`
method (same shape, narrower set).

### Adapter implementations

- `MyProcurementAdapter.resultsJobNames()` — returns the two `kind === 'results'` job
  names (`closed-quotation-results`, `closed-tender-results`), computed the same way
  `archiveJobNames()` already filters `MYPROCUREMENT_JOBS`.
- `KwspAdapter.resultsJobNames()` — returns `['results']`.
- `SpanAdapter.resultsJobNames()` — returns `[]` (no dedicated results job).

### `backend/src/scrape/manager.ts` — `ScrapeManager.refreshResults()`

```ts
refreshResults(sourceName: string): boolean {
  if (this.running) return false;
  const adapter = this.adapters.find((a) => a.name === sourceName);
  if (!adapter) return false;
  const results = new Set(adapter.resultsJobNames?.() ?? []);
  if (results.size === 0) return false;
  const remaining = this.repo.getMeta(sourceName).completedArchiveJobs.filter((j) => !results.has(j));
  void this.repo.setMeta(sourceName, { completedArchiveJobs: remaining });
  return this.start('archive', { sourceName });
}
```

Notes:
- Returns `false` (same convention as `start()`) when: a scrape is already running, the
  source name is unknown, or the adapter has no results jobs (e.g. SPAN) — the API
  route below turns each of these into the appropriate HTTP response.
- `repo.setMeta()` is called without awaiting its returned promise, and `start()` is
  called synchronously right after, in the same tick — not chained via `.then()`. This
  matters: `setMeta()`'s in-memory map update happens synchronously (before its first
  `await`), so `start()`'s own read of `completedArchiveJobs` already sees the trimmed
  list, and `start()`'s synchronous `this.running = true` guard fires in that same tick,
  closing a race where a concurrent `start()`/`refreshResults()` call could otherwise
  slip past the "already running" check while the `.then()` callback was still pending
  on real disk I/O.
- Everything after that — pagination, `onProgress`, `onBatch`, `onJobDone`
  re-persisting completion per job, flush cadence, cancellation — is the existing
  `runToCompletion('archive', ...)` path, untouched.
- If the source's `completedArchiveJobs` is already empty (initial archive backfill
  never completed, or a fresh environment), there's nothing left to filter out, so this
  degenerates into a full archive re-crawl of every job for that source rather than just
  its results jobs. Benign — a superset of the intended work, winners still get fetched
  correctly — but worth knowing.

### `backend/src/api/app.ts` — `POST /api/scrape`

`ScrapeRequestSchema`'s `scope` (currently `z.enum(['open', 'full']).optional()`) gains
a third accepted value: `z.enum(['open', 'full', 'results']).optional()`. Mapping:

```ts
if (parsed.data.scope === 'results') {
  if (!parsed.data.source) return res.status(400).json({ error: 'source is required for scope=results' });
  const started = deps.manager.refreshResults(parsed.data.source);
  if (!started) return res.status(409).json({ error: 'cannot refresh results for this source' });
  return res.status(202).json({ started: true });
}
```

(kept as an `if` before the existing `scope === 'full' ? 'all' : 'open'` line, not
folded into that ternary, since it calls a different manager method entirely).
Unlike `'open'`/`'full'` — where an omitted `source` sensibly means "every adapter" —
`'results'` has no such default (refreshing "every source's results" would silently
include sources with no results job to skip, which is more confusing than requiring
the caller to name one), so a missing `source` is a 400, not treated as "all sources".
A single `409` covers all three `refreshResults()` failure cases (already running,
unknown source, no results job) — the frontend doesn't need to distinguish them, it
already handles "scrape already running" as a generic disabled/blocked state.

### `frontend/src/api/client.ts` / `frontend/src/pages/SettingsPage.tsx`

- `triggerScrape`'s scope parameter type gains `'results'`.
- Each source row gets a third button, "Refresh awarded results", rendered only when
  that source's row data indicates it supports it. Since the frontend doesn't currently
  know `resultsJobNames()` per source, the simplest option re-uses the existing
  `/api/sources` response shape without a backend schema change: hardcode the two
  supported source names (`myprocurement`, `kwsp`) in the frontend, matching how the
  daily-cron design already hardcodes `sourceName: 'myprocurement'` in the backend
  rather than adding new cross-cutting config. If a fourth source is added later with
  its own results job, this list gets one more entry alongside its adapter — same
  one-line-per-source pattern already used elsewhere in this codebase (e.g. `ICONS` in
  `App.tsx`).
- Button styling matches the existing "Full refresh" button (bordered, not filled) to
  read as the second-tier action it is; label "Refresh awarded results" makes clear
  what it does versus "Full refresh" (which, per the Problem section, currently
  doesn't actually re-run completed jobs at all — untouched by this feature, out of
  scope to fix that separately-confusing naming here).

## Data flow / error handling

Identical to today's archive scrape once triggered — per-page flush cadence,
`onJobDone` persists completion per job (so if the browser closes or the process
crashes mid-refresh, the next click resumes from wherever it left off, not from
scratch), cancellable via the existing Cancel button and `/api/scrape/cancel`. No
schema changes to `Tender`; `winners` stays in repository.ts's `NULLABLE_FIELDS`, so a
re-scraped "no result yet" (a `results-*` card that doesn't match this tender, or a
card explicitly showing no winner) can never clobber a winner a different scrape
already established for the same tender.

## Testing

- `backend/test/manager.test.ts`: `refreshResults()` clears only the target source's
  results job names from `completedArchiveJobs` (advertisement-* / other sources'
  entries untouched); returns `false` and does nothing when a scrape is already
  running, when the source name doesn't match any adapter, or when the adapter's
  `resultsJobNames()` is empty (fake SPAN-like adapter); the subsequent scrape actually
  re-runs only the previously-completed results jobs (fake adapter asserting which job
  names it was invoked for).
- `backend/test/adapter.test.ts` (MyProcurement) /
  `backend/test/kwspAdapter.test.ts`: `resultsJobNames()` returns the expected job name
  list.
- `backend/test/spanAdapter.test.ts`: `resultsJobNames()` returns `[]`.
- `backend/test/app.test.ts`: `POST /api/scrape` with `scope: 'results'` calls
  `manager.refreshResults(source)`, not `manager.start(...)`; 409 when it returns
  false; 400 when `scope: 'results'` is sent without a `source`.
- `frontend/src/test/SettingsPage.test.tsx`: "Refresh awarded results" button renders
  for a `myprocurement` row and a `kwsp` row, not for a `span` row; clicking it calls
  `triggerScrape` with `{ source, scope: 'results' }`.

## Out of scope

- Automatic/scheduled refresh of results (daily or otherwise) — on-demand only, per
  the brainstorming decision above.
- SPAN results refresh — no separate results job exists for it to target; would need
  its own design (likely: refresh = re-run its whole closed-tender job).
- Investigating whether the ~40,895 closed tenders with `winners: null` represent a
  real gap versus tenders with no published result — noted as a finding, not
  addressed by this feature.
- Any change to the existing (differently-scoped, already-shipped) "Rescrape" /
  "Full refresh" buttons' behavior.
- A date/sort parameter for MyProcurement's `/procurements/fetch` endpoint — none was
  found during investigation; not pursued further per the brainstorming decision.
