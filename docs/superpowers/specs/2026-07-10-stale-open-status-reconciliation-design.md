# Stale "Open" Status Reconciliation — Design

**Date:** 2026-07-10
**Status:** Approved by user

## Purpose

A data validation pass found 4,665 tenders still marked `status: 'open'` even though their
closing date has already passed (4,518 of them genuinely stale — some as old as 2017; 147
closing today). Root cause: nothing in the app ever revisits an already-known tender to
flip its status once its deadline passes. The "open" rescrape only reports tenders MyProcurement
*currently* lists as open — a tender that quietly closes and drops off that listing never
gets a follow-up patch telling the repository it closed. The one-time closed/archive backfill
doesn't help either, since it already ran to completion for existing sources.

**Fix:** add a self-healing reconciliation sweep to `TenderRepository` that derives the
correct status from dates already in the data, and wire it into every point the app already
touches the data — no new scrape jobs, no schema changes.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Where the logic lives | A new `TenderRepository.reconcileStaleOpen(now?)` method — the single place all tender data flows through. Pure in-memory scan + mutate, no new dependency. |
| Closing-date cutoff | A tender flips `open` → `closed` once the current time passes **12:01pm Malaysia time (Asia/Kuala_Lumpur, UTC+8) on the closing date itself** — not the day after. Every submission is due before noon that day, so anything after 12:01pm MYT is definitively closed. Computed explicitly against the Malaysia offset (not the server's local clock), since stored dates are date-only strings with no timezone info and the server may run in UTC (e.g. Docker). |
| Missing closing date | If `closingDate` is null but `advertisedDate` is present, flip to `closed` once **more than one calendar month has passed since the advertised date** (e.g. published Jan 15 → closed any time after Feb 15). Fallback heuristic for records where a real deadline was never captured. Currently affects 0 records (all 5,768 open tenders today have a closing date) but guards against future scrapes producing an open record without one. |
| Neither date present | Left untouched — nothing to reconcile against. |
| Provenance | The sweep does **not** update `field-provenance.json`. It's a derived correction, not a scrape observation — if a genuine future patch reports this tender's status, normal provenance-based merge rules (most-recent-wins) must still apply as if the sweep never happened. |
| Trigger points | Three, all reusing existing app touchpoints — no cron library added: (1) server startup, right after `repo.load()`; (2) after every rescrape completes, in `ScrapeManager.runToCompletion`; (3) a new recurring timer via built-in `setInterval`, default every 6 hours, overridable with a `STALE_SWEEP_INTERVAL_HOURS` env var. |
| Persistence | `reconcileStaleOpen` returns the count of records it changed; callers only call `repo.flush()` when count > 0, avoiding an unnecessary 200MB+ disk write when nothing changed. |

## Backend changes

### 1. `TenderRepository.reconcileStaleOpen`

**File:** `backend/src/storage/repository.ts`

```ts
reconcileStaleOpen(now: Date = new Date()): number {
  let count = 0;
  for (const t of this.merged.values()) {
    if (t.status !== 'open') continue;

    if (t.closingDate) {
      if (now >= closingCutoff(t.closingDate)) {
        t.status = 'closed';
        count += 1;
      }
    } else if (t.advertisedDate) {
      if (now > addOneMonth(t.advertisedDate)) {
        t.status = 'closed';
        count += 1;
      }
    }
  }
  return count;
}
```

Two date helpers (new, colocated in `repository.ts` or a small `dateUtils.ts` if that reads
cleaner):

```ts
// 12:01pm Malaysia time (UTC+8, no DST) on the given YYYY-MM-DD date.
function closingCutoff(dateStr: string): Date {
  return new Date(`${dateStr}T12:01:00+08:00`);
}

// Same calendar day one month later (e.g. 2026-01-15 -> 2026-02-15).
function addOneMonth(dateStr: string): Date {
  const d = new Date(`${dateStr}T00:00:00+08:00`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}
```

Both parse the stored date-only string as a fixed `+08:00` instant, sidestepping the
server's own timezone entirely.

### 2. `backend/src/index.ts` — startup + scheduled sweep

Right after `await repo.load()`:

```ts
const staleCount = repo.reconcileStaleOpen();
if (staleCount > 0) {
  console.log(`[startup] reconciled ${staleCount} stale open tender(s)`);
  await repo.flush();
}
```

New recurring sweep, started alongside the existing startup scrape plan:

```ts
const SWEEP_INTERVAL_HOURS = Number(process.env.STALE_SWEEP_INTERVAL_HOURS) || 6;
setInterval(
  async () => {
    const count = repo.reconcileStaleOpen();
    if (count > 0) {
      console.log(`[sweep] reconciled ${count} stale open tender(s)`);
      await repo.flush();
    }
  },
  SWEEP_INTERVAL_HOURS * 60 * 60 * 1000,
).unref(); // don't keep the process alive on its own
```

### 3. `ScrapeManager.runToCompletion` — post-rescrape sweep

**File:** `backend/src/scrape/manager.ts`

After the existing per-adapter loop finishes (right before `this.current = ... 'done'`),
run the same sweep + conditional flush. Cheap add-on since a flush at the end of a run
already happens.

## Testing / TDD

- `backend/test/repository.test.ts`: new tests for `reconcileStaleOpen`, all using an
  injected `now` for determinism:
  - flips an `open` tender to `closed` when `now` is after 12:01pm MYT on its closing date
  - leaves it `open` when `now` is before that cutoff, including *earlier the same day*
  - leaves an already-`closed` tender untouched
  - flips a closing-date-less `open` tender to `closed` once over a month past
    `advertisedDate`; leaves it `open` at exactly one month and just under
  - leaves a tender with neither `closingDate` nor `advertisedDate` untouched
  - does not modify `field-provenance.json` / the provenance map
  - returns the correct count of changed records
- `backend/test/index.test.ts` (or equivalent startup test, if one exists — otherwise a
  small new test file): startup calls `reconcileStaleOpen` after `load()` and flushes only
  when it reports changes; the scheduled sweep fires reconcile+flush on the configured
  interval (using fake timers).
- `backend/test/manager.test.ts`: `runToCompletion` calls `reconcileStaleOpen` after the
  adapter loop and flushes only when it reports changes.

## Out of scope (this iteration)

- Fixing the 6 tenders where `closingDate` is before `advertisedDate` (separate,
  much smaller data-quality issue — source-side typos).
- Backfilling `closingDate` for the 67,698 already-closed tenders that lack one (structural
  gap in what MyProcurement's "results" archive endpoint exposes — not a status-correctness
  issue since those records are already `closed`).
- Any change to the `Tender`/`TenderPatch` schema.
