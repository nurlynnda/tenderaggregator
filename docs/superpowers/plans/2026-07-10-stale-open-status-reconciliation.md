# Stale "Open" Status Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically flip tenders stuck as `status: 'open'` past their real deadline back to `'closed'`, and keep doing so going forward without any new scrape jobs.

**Architecture:** A new `TenderRepository.reconcileStaleOpen(now?)` method scans the in-memory merged tender map and derives the correct status from dates already stored on each record. It's wired into three existing touchpoints — server startup, the end of every successful rescrape, and a new recurring timer — so no new scrape jobs or schema changes are needed.

**Tech Stack:** TypeScript, Node.js built-ins only (`Date`, `setInterval`) — no new npm dependency.

Full context: [docs/superpowers/specs/2026-07-10-stale-open-status-reconciliation-design.md](../specs/2026-07-10-stale-open-status-reconciliation-design.md)

## Global Constraints

- Closing-date cutoff: a tender flips `open` → `closed` once the current instant is **at or
  after 12:01pm Malaysia time (Asia/Kuala_Lumpur, UTC+8, no DST) on its `closingDate`** —
  computed against a fixed `+08:00` offset, never the server's own local clock.
- Missing-closing-date fallback: if `closingDate` is null but `advertisedDate` is present,
  flip to `closed` once the current instant is **strictly after one calendar month past
  `advertisedDate`** (e.g. `2026-01-15` → cutoff is `2026-02-15T00:00:00+08:00`). Equal to
  the cutoff still counts as open.
- If neither `closingDate` nor `advertisedDate` is present, leave the record untouched.
- The sweep must **never** write to `field-provenance.json` / the provenance map — it's a
  derived correction, not a scrape observation.
- No new npm dependency — recurring scheduling uses Node's built-in `setInterval`.
- Only call `repo.flush()` after a sweep when it actually changed at least one record.
- TDD is non-negotiable (per `CLAUDE.md`): write the failing test first, confirm it fails
  for the right reason, write the minimal implementation, confirm green, commit immediately
  — never commit red. Coverage thresholds (80% lines/branches) are enforced by vitest;
  `backend/src/index.ts` is excluded from coverage (see `backend/vitest.config.ts`) because
  it is pure startup wiring with no unit tests today — Task 3 follows that existing
  convention rather than inventing a new testing pattern for one file.

---

### Task 1: `TenderRepository.reconcileStaleOpen`

**Files:**
- Modify: `backend/src/storage/repository.ts:94` (insert new public method after `mergeMany`, before `private mergeOne`)
- Modify: `backend/src/storage/repository.ts:190` (insert two new private date helpers after `atomicWrite`, at end of file)
- Modify: `backend/test/repository.test.ts:219` (insert new tests before the closing `});` of the `describe('TenderRepository', ...)` block)

**Interfaces:**
- Consumes: nothing new — reads `this.merged` (existing `Map<string, Tender>` field) and the existing `Tender` type (`status`, `closingDate`, `advertisedDate`) from `@tms/shared`.
- Produces: `reconcileStaleOpen(now?: Date): number` — public method on `TenderRepository`, used by Task 2 (`ScrapeManager`) and Task 3 (`index.ts`). Returns the count of records it changed. Defaults `now` to `new Date()` when omitted.

- [ ] **Step 1: Write the failing tests**

Insert the following, replacing line 219 (`  });`) and line 220 (`});`) of
`backend/test/repository.test.ts` with:

```ts
  });

  it('flips an open tender to closed once past 12:01pm MYT on its closing date', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ closingDate: '2026-07-10' })]);
    const count = repo.reconcileStaleOpen(new Date('2026-07-10T04:02:00.000Z')); // 12:02pm MYT
    expect(count).toBe(1);
    expect(repo.getAll()[0]!.status).toBe('closed');
  });

  it('leaves it open before the 12:01pm MYT cutoff on the same day', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ closingDate: '2026-07-10' })]);
    const count = repo.reconcileStaleOpen(new Date('2026-07-10T03:00:00.000Z')); // 11:00am MYT
    expect(count).toBe(0);
    expect(repo.getAll()[0]!.status).toBe('open');
  });

  it('flips exactly at the 12:01pm MYT cutoff instant', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ closingDate: '2026-07-10' })]);
    const count = repo.reconcileStaleOpen(new Date('2026-07-10T04:01:00.000Z')); // exactly 12:01pm MYT
    expect(count).toBe(1);
    expect(repo.getAll()[0]!.status).toBe('closed');
  });

  it('leaves an already-closed tender untouched', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ status: 'closed', closingDate: '2020-01-01' })]);
    const count = repo.reconcileStaleOpen(new Date('2026-07-10T00:00:00.000Z'));
    expect(count).toBe(0);
    expect(repo.getAll()[0]!.status).toBe('closed');
  });

  it('flips a closing-date-less open tender to closed once more than a month past advertisedDate', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ advertisedDate: '2026-01-15' })]);
    const count = repo.reconcileStaleOpen(new Date('2026-02-16T00:00:00+08:00'));
    expect(count).toBe(1);
    expect(repo.getAll()[0]!.status).toBe('closed');
  });

  it('leaves a closing-date-less open tender open at exactly one month and just under', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([
      makePatch({ dedupKey: 'A', referenceNo: 'A', advertisedDate: '2026-01-15' }),
      makePatch({ dedupKey: 'B', referenceNo: 'B', advertisedDate: '2026-01-15' }),
    ]);
    const exactlyOneMonth = repo.reconcileStaleOpen(new Date('2026-02-15T00:00:00+08:00'));
    expect(exactlyOneMonth).toBe(0);
    const justUnder = repo.reconcileStaleOpen(new Date('2026-02-14T00:00:00+08:00'));
    expect(justUnder).toBe(0);
    expect(repo.findByDedupKey('A')!.status).toBe('open');
    expect(repo.findByDedupKey('B')!.status).toBe('open');
  });

  it('leaves a tender with neither closingDate nor advertisedDate untouched', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch()]); // no closingDate, no advertisedDate override -> both null
    const count = repo.reconcileStaleOpen(new Date('2030-01-01T00:00:00.000Z'));
    expect(count).toBe(0);
    expect(repo.getAll()[0]!.status).toBe('open');
  });

  it('does not update field-provenance.json for status, so a later genuine patch can still overwrite it', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ closingDate: '2026-01-05', scrapedAt: '2026-01-01T00:00:00.000Z' })]);
    const staleCount = repo.reconcileStaleOpen(new Date('2026-06-01T00:00:00.000Z'));
    expect(staleCount).toBe(1);
    expect(repo.getAll()[0]!.status).toBe('closed');

    // A genuine patch dated after the ORIGINAL scrape (but well before reconcile's `now`)
    // must still be able to overwrite status — proving reconcile never touched provenance.
    repo.mergeMany([makePatch({ status: 'open', scrapedAt: '2026-02-01T00:00:00.000Z' })]);
    expect(repo.getAll()[0]!.status).toBe('open');
  });

  it('returns the count of records changed, ignoring ones that are not eligible', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([
      makePatch({ dedupKey: 'STALE/1', referenceNo: 'STALE/1', closingDate: '2020-01-01' }),
      makePatch({ dedupKey: 'STALE/2', referenceNo: 'STALE/2', closingDate: '2021-01-01' }),
      makePatch({ dedupKey: 'FRESH/1', referenceNo: 'FRESH/1', closingDate: '2030-01-01' }),
    ]);
    const count = repo.reconcileStaleOpen(new Date('2026-07-10T00:00:00.000Z'));
    expect(count).toBe(2);
    expect(repo.findByDedupKey('STALE/1')!.status).toBe('closed');
    expect(repo.findByDedupKey('STALE/2')!.status).toBe('closed');
    expect(repo.findByDedupKey('FRESH/1')!.status).toBe('open');
  });
});
```

(The first `});` you're inserting before closes the pre-existing "handles a large merge +
flush" test; everything after it is new; the final `});` closes the outer
`describe('TenderRepository', ...)` block, same as before.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run test/repository.test.ts`
Expected: FAIL — `repo.reconcileStaleOpen is not a function`

- [ ] **Step 3: Write the minimal implementation**

In `backend/src/storage/repository.ts`, insert this method right after the closing brace of
`mergeMany` (currently line 94) and before `private mergeOne(patch: TenderPatch): void {`
(currently line 96):

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

Then append these two private helpers at the very end of the file (after the closing brace
of `atomicWrite`, currently line 190):

```ts
// 12:01pm Malaysia time (UTC+8, no DST) on the given YYYY-MM-DD closing date — every
// submission is due before noon that day, so anything at or after this instant is closed.
function closingCutoff(dateStr: string): Date {
  return new Date(`${dateStr}T12:01:00+08:00`);
}

// Same calendar day one month later (e.g. 2026-01-15 -> 2026-02-15, at midnight MYT), used
// as a fallback deadline for records where a real closing date was never captured.
function addOneMonth(dateStr: string): Date {
  const d = new Date(`${dateStr}T00:00:00+08:00`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run test/repository.test.ts`
Expected: PASS — all tests in the file, including the 9 new ones, green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/storage/repository.ts backend/test/repository.test.ts
git commit -m "feat(backend): add reconcileStaleOpen to derive closed status from dates"
```

---

### Task 2: Wire reconciliation into `ScrapeManager.runToCompletion`

**Files:**
- Modify: `backend/src/scrape/manager.ts:110` (insert reconcile + conditional flush between the end of the adapter loop and the `this.current = ...` status assignment)
- Modify: `backend/test/manager.test.ts:218` (insert new tests before the closing `});` of the `describe('ScrapeManager', ...)` block)

**Interfaces:**
- Consumes: `TenderRepository.reconcileStaleOpen(now?: Date): number` from Task 1.
- Produces: no new public API — `runToCompletion`'s existing behavior gains a side effect (status reconciliation) after a successful run.

- [ ] **Step 1: Write the failing tests**

Insert the following, replacing line 218 (`  });`) and line 219 (`});`) of
`backend/test/manager.test.ts` with:

```ts
  });

  it('reconciles stale open tenders after the run completes, flushing an extra time only when something changed', async () => {
    const repo = await freshRepo();
    const originalFlush = repo.flush.bind(repo);
    let flushCount = 0;
    repo.flush = async () => { flushCount += 1; return originalFlush(); };
    const stalePatch: TenderPatch = {
      dedupKey: 'STALE/1', referenceNo: 'STALE/1', title: 'Stale Tender',
      status: 'open', procurementType: 'quotation',
      scrapedAt: NOW(),
      closingDate: '2026-01-01',
      source: { source: 'fake', sourceId: '1', sourceUrl: 'https://example.com/1' },
    };
    const adapter = fakeAdapter(async (_s, hooks) => { await hooks.onBatch([stalePatch]); });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('open');
    expect(repo.getAll()[0]!.status).toBe('closed');
    expect(flushCount).toBe(2); // one per-adapter flush + one extra from reconciliation finding a change
  });

  it('does not perform an extra flush when reconciliation finds nothing stale', async () => {
    const repo = await freshRepo();
    const originalFlush = repo.flush.bind(repo);
    let flushCount = 0;
    repo.flush = async () => { flushCount += 1; return originalFlush(); };
    const freshPatch: TenderPatch = {
      dedupKey: 'FRESH/1', referenceNo: 'FRESH/1', title: 'Fresh Tender',
      status: 'open', procurementType: 'quotation',
      scrapedAt: NOW(),
      closingDate: '2026-12-31',
      source: { source: 'fake', sourceId: '1', sourceUrl: 'https://example.com/1' },
    };
    const adapter = fakeAdapter(async (_s, hooks) => { await hooks.onBatch([freshPatch]); });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('open');
    expect(repo.getAll()[0]!.status).toBe('open');
    expect(flushCount).toBe(1); // just the one per-adapter flush; reconciliation found nothing to change
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run test/manager.test.ts`
Expected: FAIL — `expect(repo.getAll()[0]!.status).toBe('closed')` receives `'open'` (nothing reconciles it yet).

- [ ] **Step 3: Write the minimal implementation**

In `backend/src/scrape/manager.ts`, replace this line (currently line 110):

```ts
      this.current = this.cancelRequested ? { state: 'cancelled', source: activeSource } : { state: 'done' };
```

with:

```ts
      if (!this.cancelRequested) {
        const staleCount = this.repo.reconcileStaleOpen(new Date(now()));
        if (staleCount > 0) await this.repo.flush();
      }
      this.current = this.cancelRequested ? { state: 'cancelled', source: activeSource } : { state: 'done' };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run test/manager.test.ts`
Expected: PASS — all tests in the file, including the 2 new ones, green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrape/manager.ts backend/test/manager.test.ts
git commit -m "feat(backend): reconcile stale open tenders after every completed scrape run"
```

---

### Task 3: Startup reconciliation + recurring sweep

**Files:**
- Modify: `backend/src/index.ts:15` (insert startup reconcile + conditional flush right after `await repo.load();`)
- Modify: `backend/src/index.ts:50` (insert recurring `setInterval` sweep after the startup scrape-plan block, before `createApp(...)`)

**Interfaces:**
- Consumes: `TenderRepository.reconcileStaleOpen(now?: Date): number` from Task 1.
- Produces: nothing consumed by later tasks — this is the final wiring task.

No dedicated automated test for this task: `backend/src/index.ts` is excluded from coverage
(`backend/vitest.config.ts`) and has no existing unit tests — it's pure startup wiring,
already exercised indirectly by `manager.test.ts` (Task 2) and `repository.test.ts` (Task 1)
for the logic it calls. This follows the same pattern the codebase already uses for the
per-adapter startup scrape plan a few lines above.

- [ ] **Step 1: Add startup reconciliation**

In `backend/src/index.ts`, replace:

```ts
  const repo = new TenderRepository(DATA_DIR);
  await repo.load();

  const adapters = [
```

with:

```ts
  const repo = new TenderRepository(DATA_DIR);
  await repo.load();

  // Self-heals tenders left stuck as "open" past their deadline (see
  // docs/superpowers/specs/2026-07-10-stale-open-status-reconciliation-design.md) — fixes
  // whatever accumulated since this last ran; the recurring sweep below (see end of main())
  // keeps catching up even if nobody restarts the server or triggers a rescrape.
  const startupStaleCount = repo.reconcileStaleOpen();
  if (startupStaleCount > 0) {
    console.log(`[startup] reconciled ${startupStaleCount} stale open tender(s)`);
    await repo.flush();
  }

  const adapters = [
```

- [ ] **Step 2: Add the recurring sweep**

In `backend/src/index.ts`, replace:

```ts
  if (plan.length > 0) {
    void (async () => {
      for (const { name, scope } of plan) {
        console.log(`[startup] ${name}: running ${scope} scrape`);
        await manager.runToCompletion(scope, { sourceName: name });
      }
    })();
  }

  createApp({ repo, manager }).listen(PORT, () => {
```

with:

```ts
  if (plan.length > 0) {
    void (async () => {
      for (const { name, scope } of plan) {
        console.log(`[startup] ${name}: running ${scope} scrape`);
        await manager.runToCompletion(scope, { sourceName: name });
      }
    })();
  }

  const sweepIntervalHours = Number(process.env.STALE_SWEEP_INTERVAL_HOURS) || 6;
  setInterval(
    async () => {
      const count = repo.reconcileStaleOpen();
      if (count > 0) {
        console.log(`[sweep] reconciled ${count} stale open tender(s)`);
        await repo.flush();
      }
    },
    sweepIntervalHours * 60 * 60 * 1000,
  ).unref();

  createApp({ repo, manager }).listen(PORT, () => {
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — all existing suites (shared, backend, frontend) still green; this task
touches no tested code path directly, so this just confirms nothing else broke.

- [ ] **Step 4: Manual smoke test**

Run the dev server against a throwaway empty data directory and confirm it starts cleanly
with no crash and no stale-tender log line (nothing to reconcile in an empty store):

```bash
cd backend
DATA_DIR=$(mktemp -d) PORT=3099 npx tsx src/index.ts
```

Expected console output: `backend listening on :3099` and nothing else — no `[startup]
reconciled` line (empty store, nothing to reconcile), no thrown errors. Stop it with
Ctrl+C once confirmed.

Optionally, to see it act on the real dataset: run `npm run dev -w backend` (uses the
real `backend/data` directory) and confirm a line like `[startup] reconciled 4665 stale
open tender(s)` appears (the exact count will differ slightly from the original 4,665
depending on today's date). This is the one-time fix for the data found during validation —
no separate migration script is needed since reconciliation is now self-healing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(backend): reconcile stale open tenders at startup and on a recurring sweep"
```
