# Per-Source Scrape Management & Settings Page — Design

**Date:** 2026-07-10
**Status:** Approved by user

## Purpose

Fix a real bug found while testing the SPAN data source (added in
[2026-07-09-span-tender-source-design.md](2026-07-09-span-tender-source-design.md)), and
replace the single global "Rescrape" button with a per-source control surface on a new
Settings page, so adding future sources doesn't repeat the same class of bug and users can
manage each source independently.

## The bug being fixed

`decideStartupPolicy` (`backend/src/startupPolicy.ts`) currently computes one **combined**
decision across every registered adapter: `needsFull` is true only if *every* adapter has
never run, and `needsBackfill` is true if *any* adapter has incomplete archive jobs.
`backend/src/index.ts` then calls `manager.start(scope)` once with that single scope,
applied identically to *every* adapter.

Consequence: when SPAN was added to a deployment where MyProcurement already had data,
`needsFull` was `false` (MyProcurement has run) and `needsBackfill` was `true` (SPAN's
archive isn't done) — so startup ran `scope='archive'` for **every** adapter, including
brand-new SPAN. Since `scope='archive'` structurally excludes the current-year ("open")
job, SPAN's 2026 tenders were never scheduled at all — only a manual Rescrape (which is
`scope='open'`) would have fetched them, and nothing in the UI hinted this was needed. The
same gap will recur for any future new source.

**Fix:** make the startup decision **per-adapter** instead of combined, so a brand-new
adapter always gets its own full scrape regardless of what other adapters have already
done.

## Other investigation (informational, no code change)

Checked whether SPAN might be rejecting requests based on headers (e.g. User-Agent
filtering): compared responses with our bot User-Agent, no User-Agent, and a full browser
User-Agent — all three returned identical `200 OK` responses from a plain Apache/PHP
server with no CDN or bot-protection headers present. No evidence of header-based
rejection; the one observed "fetch failed after 3 attempts" was most likely a transient
network/server hiccup, already covered by the existing retry/backoff logic. No change
needed here.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Fetch-again scope | User picks per click: **open** (current listings only, fast) or **full** (open + entire historical backfill for that one source). Two distinct buttons per source row, not a dropdown. |
| Concurrency | Keep the single app-wide scrape lock (only one source fetches at a time) — but add a **Cancel** button so a long-running scrape can be stopped instead of waited out. |
| Cancellation granularity | Cooperative: the running adapter checks "should I stop?" between jobs/pages (per-year for SPAN, per-page for MyProcurement) and returns early rather than continuing. An in-flight single HTTP request is allowed to finish; nothing aborts mid-request. Data already flushed before a cancel stays saved (same principle as an existing failure). |
| Rescrape UI location | Moves entirely off the main header. A **Settings** link is pinned to the bottom of the left navbar (visually separated from the Open/Closed/Awarded links), leading to a **Data Sources** section listing every registered source. |

## Backend changes

### 1. `decideStartupPolicy` becomes single-adapter

**File:** `backend/src/startupPolicy.ts`

New signature — called once per adapter, not once for the whole app:

```ts
export interface StartupPolicyDeps {
  hasSource: boolean;              // this adapter only
  mergedIsEmpty: boolean;          // whole merged store empty — a global fact, shared across adapters
  archiveJobNames: string[];       // this adapter's own archive job names
  completedArchiveJobs: string[];  // this adapter's own completed archive job names
}

export interface StartupPolicyResult {
  needsFull: boolean;
  needsBackfill: boolean;
  emptyStoreMismatch: boolean;
}

export function decideStartupPolicy(deps: StartupPolicyDeps): StartupPolicyResult {
  const needsFull = !deps.hasSource || deps.mergedIsEmpty;
  const completed = new Set(deps.completedArchiveJobs);
  const needsBackfill = deps.archiveJobNames.some((job) => !completed.has(job));
  const emptyStoreMismatch = deps.mergedIsEmpty && deps.hasSource;
  return { needsFull, needsBackfill, emptyStoreMismatch };
}
```

`needsFull` is now true whenever *this* adapter has never run (`!hasSource`) OR the merged
store is globally empty (self-heal case, unchanged from before) — no longer gated on every
other adapter's state too.

### 2. `backend/src/index.ts` — per-adapter startup orchestration

Computes a per-adapter plan, then runs each needed adapter's startup scrape **sequentially
in the background** (never blocking `.listen()` — the "server serves immediately"
guarantee is unchanged):

```ts
const mergedIsEmpty = repo.getAll().length === 0;
const plan: Array<{ name: string; scope: 'all' | 'archive' }> = [];

for (const adapter of adapters) {
  const { needsFull, needsBackfill, emptyStoreMismatch } = decideStartupPolicy({
    hasSource: repo.hasSource(adapter.name),
    mergedIsEmpty,
    archiveJobNames: adapter.archiveJobNames(),
    completedArchiveJobs: repo.getMeta(adapter.name).completedArchiveJobs,
  });
  if (emptyStoreMismatch) {
    console.warn(`[startup] ${adapter.name}: merged store empty but source reports prior completion — forcing full rescrape`);
  }
  if (needsFull) plan.push({ name: adapter.name, scope: 'all' });
  else if (needsBackfill) plan.push({ name: adapter.name, scope: 'archive' });
}

if (plan.length > 0) {
  void (async () => {
    for (const { name, scope } of plan) {
      console.log(`[startup] ${name}: running ${scope} scrape`);
      await manager.runToCompletion(scope, { sourceName: name });
    }
  })();
}
```

Each adapter that needs work runs to completion before the next one starts (the manager
still only supports one run at a time), but this no longer requires *all* adapters to
share the same scope — a fully-bootstrapped MyProcurement can need nothing while a
brand-new SPAN gets `scope='all'`.

### 3. `ScrapeManager` — source-scoped runs + cancellation

**File:** `backend/src/scrape/manager.ts`

- `start(scope, opts?: { sourceName?: string })` and `runToCompletion(scope, opts?)`: when
  `sourceName` is given, only the matching adapter runs (filtered from `this.adapters`);
  omitted means every adapter, unchanged from today.
- New `cancel(): boolean` — returns `false` if nothing is running; otherwise flags the
  current run to stop and returns `true`.
- `ScrapeStatus.state` gains a `'cancelled'` value alongside
  `idle | running | done | failed`.
- New `listSources(): Array<{ name: string; lastScrapedAt: string | null; lastArchiveBackfillAt: string | null; total: number }>` —
  reads each adapter's name plus its `repo.getMeta(name)`, for the Settings page.
- Cancellation propagation: `ScrapeOptions` (in `backend/src/scrapers/types.ts`) gains
  `isCancelled?: () => boolean`. **Both** `MyProcurementAdapter` (checked once per page, in
  its `do...while` loop) and `SpanAdapter` (checked once per year, in its `for` loop) check
  it at the top of each iteration and return normally (not throw) if it reports `true`, so
  the manager can report `'cancelled'` rather than `'failed'`. This touches the existing
  MyProcurement adapter too — cancellation must work consistently regardless of which
  source is currently running.

### 4. API endpoints

**File:** `backend/src/api/app.ts`

- **New** `GET /api/sources` → `deps.manager.listSources()`, unwrapped as a JSON array.
- **Changed** `POST /api/scrape` — body `{ source?: string, scope?: 'open' | 'full' }`
  (both optional; `scope` defaults to `'open'`, `source` omitted means every adapter — same
  default behavior as today for any caller that doesn't pass either field).
  `scope: 'full'` maps to the manager's internal `'all'` scope value; `'open'` maps to
  `'open'` directly. Returns `202 { started: true }` on success, `409` if a scrape is
  already running (unchanged).
- **New** `POST /api/scrape/cancel` → `deps.manager.cancel()`; `200 { cancelled: true }` if
  something was running, `409 { error: 'nothing running' }` otherwise.
- `GET /api/scrape/status` — unchanged response shape (now can also report `state:
  'cancelled'`).

## Frontend changes

- **`frontend/src/App.tsx`**: left navbar gets a `Settings` link pinned to the bottom
  (flex column with a spacer pushing it down, separate from the Open/Closed/Awarded
  group). New route `/settings` → `SettingsPage`. The header's `ScrapeBanner` is removed
  entirely — no replacement indicator elsewhere; Settings is now the single place scrape
  state and controls live.
- **New `frontend/src/pages/SettingsPage.tsx`**: a "Data Sources" section — one row per
  source (`name`, `lastScrapedAt`, `lastArchiveBackfillAt`, `total`, all from
  `GET /api/sources`). Each row has two buttons, **Fetch open** and **Full refresh**,
  calling `POST /api/scrape` with `{ source: name, scope: 'open' | 'full' }` respectively.
  While `GET /api/scrape/status` reports `state: 'running'` for that row's source, the row
  shows inline progress text (job/page counts, same information the old banner showed) and
  swaps its two buttons for a single **Cancel** button (`POST /api/scrape/cancel`); every
  *other* row's buttons are disabled meanwhile (single shared lock, unchanged concurrency
  model — just distributed across rows instead of one global button).
- **`frontend/src/components/ScrapeBanner.tsx`**: removed; its polling/mutation logic is
  absorbed into `SettingsPage.tsx` (per-source instead of global).
- **`frontend/src/api/client.ts`**: `triggerScrape` gains `{ source, scope }` parameters;
  new `fetchSources()` and `cancelScrape()` functions.

## Testing / TDD

- `backend/test/startupPolicy.test.ts`: rewritten for the new single-adapter signature —
  same scenarios as today (no source ever run, empty-store mismatch, fully caught up,
  backfill-only, new-job-kind-added), plus the scenario this whole fix targets: one
  already-bootstrapped adapter alongside one brand-new adapter, asserting the new adapter
  independently gets `needsFull: true` regardless of the other's state.
- `backend/test/manager.test.ts`: new tests for `sourceName`-filtered runs (only the named
  adapter's `scrape()` is invoked) and for `cancel()` (a scrape mid-run stops at the next
  checkpoint, status reports `'cancelled'`, already-flushed data is retained, `cancel()`
  returns `false` when nothing is running).
- `backend/test/adapter.test.ts` and `backend/test/spanAdapter.test.ts`: new tests
  confirming each adapter's loop honors `opts.isCancelled` — stops before the next
  page/year and returns normally rather than throwing.
- `backend/test/app.test.ts`: new tests for `GET /api/sources`, `POST /api/scrape` with
  `source`/`scope` body fields (including the `'full'` → `'all'` mapping), and
  `POST /api/scrape/cancel` (200 when running, 409 when not).
- Frontend: new `frontend/src/test/SettingsPage.test.tsx` (renders sources, per-row
  buttons trigger the right request body, running row shows progress + Cancel, other rows
  disabled meanwhile); `frontend/src/test/App.test.tsx` updated for the new nav link and
  route; `frontend/src/test/ScrapeBanner.test.tsx` removed (component removed).

## Out of scope (this iteration)

- True concurrent multi-source scraping (the shared lock stays).
- Aborting an in-flight HTTP request mid-flight — cancellation is checked between
  jobs/pages only.
- Any change to parsing, dedup, or the `Tender`/`TenderPatch` schema.
