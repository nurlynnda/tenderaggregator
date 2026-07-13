# Daily 12:01pm close-and-rescrape cron

## Problem

Tenders should flip from `open` to `closed` the moment their stated closing date's
noon deadline passes (every submission is due before noon MYT — see
`closingCutoff()` in `backend/src/storage/repository.ts`), and newly published
tenders should be picked up the same day. Today this only happens:

- on server startup,
- after any manual scrape completes,
- on a periodic 6-hour `setInterval` sweep (`STALE_SWEEP_INTERVAL_HOURS` in
  `backend/src/index.ts`) that reconciles stale-open status but never triggers a
  scrape.

None of this is pinned to a clock time. This spec replaces the 6-hour sweep with a
scheduler that fires at exactly **12:01pm Malaysia time (UTC+8, no DST)** every day,
closes any tenders whose closing date is today, and then rescrapes open tenders on
MyProcurement (the only source scraped automatically — SPAN and KWSP are excluded
from this daily trigger and remain manual-only via the existing "Rescrape" button).

## Behavior

At 12:01pm MYT daily:

1. Reconcile stale-open tenders (`repo.reconcileStaleOpen()`) and flush — always
   runs immediately, independent of scrape state.
2. Wait for any in-progress scrape to finish (if one is running — e.g. a user
   clicked "Rescrape" manually right before noon).
3. Start an `open`-scope scrape scoped to the `myprocurement` source only
   (equivalent to clicking "Rescrape" for just that one source).

If the server is down at 12:01pm on a given day, it catches up automatically on
next startup: if today's run hasn't happened yet and it's already past 12:01pm MYT,
run immediately instead of waiting for tomorrow.

The next day's 12:01pm trigger is scheduled as soon as today's fires (based on wall
clock), not after step 3 finishes — so a long-running catch-up scrape never pushes
tomorrow's trigger later.

## Components

### `backend/src/scheduler/dailyTrigger.ts` (pure functions, no I/O)

- `nextFireTime(now: Date): Date` — the next 12:01pm MYT instant strictly after `now`.
- `mytDateString(now: Date): string` — today's date in MYT as `YYYY-MM-DD`.
- `missedToday(now: Date, lastRunDate: string | null): boolean` — true if it's
  already at/past 12:01pm MYT today and `lastRunDate` isn't today's MYT date.

### `backend/src/scheduler/DailyScheduler.ts`

Wires the pure functions to a real (or injected, for tests) clock and timer:

- Constructor takes `{ run: () => Promise<void>, loadLastRunDate: () => Promise<string | null>, saveLastRunDate: (date: string) => Promise<void>, now?: () => Date, setTimeoutFn?, clearTimeoutFn? }`.
- `start()`: loads last-run-date; if `missedToday()`, fires immediately; otherwise
  arms a single timer to `nextFireTime()` (always ≤ ~24h, so no 32-bit
  `setTimeout` overflow risk). Each fire: persists today's MYT date as last-run
  date, schedules the *next* day's timer right away, then kicks off `run()` in
  the background (errors are caught and logged, never crash the process).
- `stop()`: clears any pending timer (for tests/shutdown).

### `backend/src/scrape/manager.ts` change

Add `waitUntilIdle(): Promise<void>` — resolves immediately if idle, otherwise
resolves when the in-flight `runToCompletion()` finishes. Implemented by storing
the promise returned from `runToCompletion()` when `start()` is called.

### State persistence

New file `daily-schedule.json` in `DATA_DIR`: `{ "lastRunDate": "2026-07-11" }`.
Plain read/write (mirrors the existing `atomicWrite` pattern used elsewhere in
`repository.ts`, duplicated locally rather than exported/shared since it's a
three-line helper).

### `backend/src/index.ts` change

Remove the `STALE_SWEEP_INTERVAL_HOURS` / `setInterval` block entirely. Construct
`DailyScheduler` with `repo.reconcileStaleOpen`/`repo.flush`, `manager.waitUntilIdle`/
`manager.start('open', { sourceName: 'myprocurement' })`, and the state file path
under `DATA_DIR`; call `.start()`.

## Error handling

- `run()` errors (reconcile failure, scrape failure) are caught and logged with a
  `[daily]` prefix; they never crash the process or prevent tomorrow's trigger
  (already scheduled independently — see above).
- `manager.start('open', { sourceName: 'myprocurement' })` racing with a concurrent manual start after
  `waitUntilIdle()` resolves is a rare, harmless case: `start()` simply returns
  `false`, which is logged (`[daily] scrape already in progress after waiting —
  skipping today's auto-scrape`) rather than retried indefinitely.

## Testing

- `dailyTrigger.test.ts`: table-driven cases for `nextFireTime` (just before
  12:01pm, just after, exactly at 12:01:00, across month/year boundaries) and
  `missedToday` (never run, ran today already, ran on a previous day and now past
  noon, ran on a previous day and now before noon).
- `DailyScheduler.test.ts`: fake clock + fake timer functions + fake
  `run`/persistence to verify: catch-up-on-start when today's run is missing and
  it's past noon, normal scheduled firing, next-day timer armed independent of
  `run()` duration, and that `run()` throwing doesn't stop future scheduling.
- `manager.test.ts` addition: `waitUntilIdle()` resolves immediately when idle,
  and resolves only after an in-flight `runToCompletion()` (driven by a fake
  slow adapter) completes.

## Out of scope

- No new env var / configurability for the trigger time — it's fixed at 12:01pm
  MYT to match the existing `closingCutoff()` semantics.
- No UI changes; this is a backend-only scheduling change.
