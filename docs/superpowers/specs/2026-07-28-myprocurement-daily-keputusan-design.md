# Daily Keputusan scraping for MyProcurement awarded results

## Problem

The app's "awarded tender" data for MyProcurement comes from the Arkib (archive)
results feed (`archive/results-quotation`, `archive/results-tender`), which is only
ever scraped once during the initial backfill, then re-scraped on demand via the
"Refresh awarded results" button.

The user discovered that Arkib is not where MyProcurement's results first appear —
a tender's award result shows up on the site's **Keputusan** (results) listing
(`/results/quotation`, `/results/tender`) as soon as it's decided, and only migrates
into Arkib months later. So even clicking "Refresh awarded results" today doesn't
get fresh data — it re-crawls a feed that itself lags behind by months.

## Investigation findings (2026-07-28, live site)

Checked `myprocurement.treasury.gov.my` directly (lightweight requests, not a scrape):

- The site has two distinct results feeds behind the same `/procurements/fetch`
  endpoint used everywhere else in this adapter:
  - **Keputusan** (current): `type=results&category=quotation` → **51 pages**;
    `type=results&category=tender` → **8 pages** (at 100 items/page, ~5,900 items
    total). Cards show `Tarikh Paparan Keputusan: <today's date>` — genuinely
    current.
  - **Arkib** (historical): `type=archive&category=results-quotation` → 1,178
    pages; `type=archive&category=results-tender` similarly large — the full
    historical backlog, already established as expensive in
    [2026-07-14-refresh-awarded-results-design.md](2026-07-14-refresh-awarded-results-design.md).
- Keputusan's card HTML is **byte-for-byte the same template** the existing
  `parseResultsHtml` (`backend/src/scrapers/myprocurement/parseResults.ts`) already
  parses for Arkib results: same `x-data` selection wrapper, same
  `div.font-bold.text-primary a` title link, same `div.font-bold.align-top`
  label/value pairs (`Kementerian`, `Agensi`, `Kategori Perolehan`), same
  `span.font-bold` reference-number span, same winner `<table>`. No new parsing
  code needed — it's the same feed, just queried through the fresher URL.

## Decision

- Add two new jobs to `MYPROCUREMENT_JOBS` targeting Keputusan
  (`type=results&category=quotation` / `type=results&category=tender`), reusing
  `parseResultsHtml` unchanged.
- These jobs run as part of any `open`-scope scrape — the existing daily 12:01pm
  cron ([2026-07-11-daily-close-and-rescrape-cron-design.md](2026-07-11-daily-close-and-rescrape-cron-design.md))
  and the manual per-source "Rescrape" button both already trigger `open`-scope
  scrapes for MyProcurement, so Keputusan starts getting scraped daily with no new
  scheduler code.
- They never get skipped by the "already completed" backfill logic — same as open
  jobs, they should re-run in full every time, since freshly-awarded results appear
  continuously and there's no incremental/date-filtered query available on this
  endpoint (already established in the prior design doc).
- The one-time Arkib backfill (`archive/results-quotation`, `archive/results-tender`)
  is untouched — still needed once, to establish full historical winner data an
  environment wouldn't otherwise have (Keputusan only ever shows the current
  window, not the full history).
- MyProcurement's on-demand "Refresh awarded results" capability is removed: its
  `resultsJobNames()` now returns `[]` (mirroring `SpanAdapter`'s existing "no
  on-demand results job" pattern), so the button stops appearing for MyProcurement's
  row in Settings. It's redundant now that Keputusan is fresh and scraped daily, and
  it was the mechanism that turned out not to help freshness in the first place.
  KWSP's and LLM's own results-refresh buttons are untouched — different, cheap
  mechanism, no freshness problem reported there.

## Architecture

### `backend/src/scrapers/myprocurement/adapter.ts`

Two new entries in `MYPROCUREMENT_JOBS`:

```ts
{ status: 'closed', procurementType: 'quotation', type: 'results', category: 'quotation', kind: 'daily-results' },
{ status: 'closed', procurementType: 'tender', type: 'results', category: 'tender', kind: 'daily-results' },
```

`jobName()` gains a branch for the new kind, producing distinct names that can't
collide with the existing `results` kind's `${status}-${procurementType}-results`
naming:

```ts
function jobName(job: MyProcurementJob): string {
  if (job.kind === 'results') return `${job.status}-${job.procurementType}-results`;
  if (job.kind === 'daily-results') return `${job.procurementType}-keputusan`;
  return `${job.status}-${job.procurementType}`;
}
```

`scrape()`'s scope filter and skip-check both gain a `kind === 'daily-results'`
carve-out — in-scope whenever `open` or `all` runs (in addition to the existing
`open`-status jobs), and never skipped regardless of `completedArchiveJobs`:

```ts
const jobs = MYPROCUREMENT_JOBS.filter((j) => {
  const inScope = scope === 'all' ? true
    : scope === 'open' ? (j.status === 'open' || j.kind === 'daily-results')
    : j.status === 'closed';
  if (!inScope) return false;
  if (j.status === 'closed' && j.kind !== 'daily-results' && opts.skipJobNames?.has(jobName(j))) return false;
  return true;
});
```

The parse-branch also treats `daily-results` like `results`:

```ts
const patches = job.kind === 'results' || job.kind === 'daily-results'
  ? parseResultsHtml(body.html, { procurementType: job.procurementType })
  : parseListingHtml(body.html, { status: job.status, procurementType: job.procurementType });
```

`archiveJobNames()` excludes the new kind, so it never affects
`decideStartupPolicy`'s backfill-completeness check (a job that's designed to
always re-run has no "completed" state to track):

```ts
archiveJobNames(): string[] {
  return MYPROCUREMENT_JOBS.filter((j) => j.status === 'closed' && j.kind !== 'daily-results').map(jobName);
}
```

`resultsJobNames()` changes from returning the two Arkib results job names to
returning `[]`:

```ts
resultsJobNames(): string[] {
  return [];
}
```

`archive`-scope scrapes (initial backfill, or any future `refreshResults()` call
for a *different* source that happens to run the whole adapter) will still pick up
the two `daily-results` jobs, since their `status` is `'closed'` — harmless
overlap with the daily `open`-scope run, not a bug worth special-casing out.

### `frontend/src/pages/SettingsPage.tsx`

`SOURCES_WITH_RESULTS_REFRESH` drops `'myprocurement'`, keeping `'kwsp'` and
`'llm'`. No other frontend change — the button's visibility is already driven
entirely by this hardcoded set (documented at its definition as intentionally not
derived from `resultsJobNames()`).

## Data flow / error handling

Identical to the existing `open`-scope scrape pipeline — pagination, rate limiting,
progress reporting, `onBatch` merging. No schema changes; `parseResultsHtml`
already emits `Tender` patches through the same `TenderPatchSchema` validation as
every other job. A tender whose winner data hasn't changed just gets re-merged with
the same values (no-op in effect); a newly-awarded tender's winner appears the next
time the daily cron or a manual Rescrape runs.

## Testing

- `backend/test/adapter.test.ts`:
  - `MYPROCUREMENT_JOBS` now defines 10 entries (was 8) — update the "exactly the
    8 verified combinations" test to 10, including the two new `daily-results`
    entries.
  - `scope=open` now crawls 5 jobs (3 advertisement + 2 Keputusan), not 3 — update
    the URL-count assertion and add a check that the two new URLs use
    `type=results` with `category` of `quotation`/`tender` (not
    `results-quotation`/`results-tender`).
  - A new test: Keputusan jobs are never skipped even when their job names are
    passed in `skipJobNames` (mirroring the existing "never skips open jobs" test).
  - `archiveJobNames()` stays at 5 entries (unchanged) — add an explicit assertion
    that it does NOT include `quotation-keputusan` / `tender-keputusan`.
  - `resultsJobNames()` now returns `[]` — update the existing test.
  - `scope=all` job-count assertions updated for the 2 extra always-run jobs.
- `backend/test/manager.test.ts`: no changes expected (adapter-level change only;
  `refreshResults('myprocurement')` already returns `false` generically whenever
  `resultsJobNames()` is empty — same path SPAN already exercises).
- `frontend/src/test/SettingsPage.test.tsx`: the existing test asserting the button
  renders for `myprocurement` flips to asserting it does NOT render for
  `myprocurement`, while still rendering for `kwsp`.

## Out of scope

- Any change to the Arkib archive backfill jobs themselves (`archive/results-*`)
  — they still run once, for full historical coverage.
- Any change to KWSP's or LLM's on-demand results-refresh capability.
- A date/incremental filter on the Keputusan endpoint — none exists (same finding
  as the prior Arkib investigation); the whole Keputusan feed (~59 pages) is cheap
  enough to re-fetch in full daily.
- Investigating the ~40,895 closed tenders with `winners: null` noted in the prior
  design doc — unrelated to this feature.
