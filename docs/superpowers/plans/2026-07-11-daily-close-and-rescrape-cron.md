# Daily 12:01pm Close-and-Rescrape Cron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the periodic 6-hour stale-open sweep with a scheduler that fires at exactly 12:01pm Malaysia time every day, closes tenders whose closing date is today, and rescrapes open tenders on MyProcurement only (SPAN and KWSP stay manual-only via the existing "Rescrape" button).

**Architecture:** A pure date-math module (`dailyTrigger.ts`) computes fire times and catch-up decisions with no I/O, so it's trivially unit-testable. A small file-backed store (`dailyRunState.ts`) persists the last-run date. `DailyScheduler` wires the two together with an injectable clock/timer so tests never wait on real time. `ScrapeManager` gains `waitUntilIdle()` so the scheduler can wait out a concurrent manual scrape instead of skipping. `index.ts` wires it all up in place of the old `setInterval` sweep.

**Tech Stack:** TypeScript, Node `node:fs/promises`, Vitest. No new dependencies.

## Global Constraints

- Fire time is fixed at 12:01pm Malaysia time (UTC+8, no DST) — matches `closingCutoff()` in `backend/src/storage/repository.ts:232` (`` `${dateStr}T12:01:00+08:00` ``). No env var for configuring it.
- Tests must never rely on real wall-clock waits (no `setTimeout`-based sleeps to reach a real future time); use injected clocks/timer functions.
- ESM everywhere — relative imports use explicit `.js` extensions (matches existing files, e.g. `backend/src/scrape/manager.ts`).
- TDD: write the failing test first, confirm it fails, implement, confirm it passes, commit. Never commit red.

---

### Task 1: `dailyTrigger.ts` — pure fire-time math

**Files:**
- Create: `backend/src/scheduler/dailyTrigger.ts`
- Test: `backend/test/dailyTrigger.test.ts`

**Interfaces:**
- Produces: `nextFireTime(now: Date): Date`, `mytDateString(now: Date): string`, `missedToday(now: Date, lastRunDate: string | null): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/dailyTrigger.test.ts
import { describe, expect, it } from 'vitest';
import { nextFireTime, mytDateString, missedToday } from '../src/scheduler/dailyTrigger.js';

describe('nextFireTime', () => {
  it('returns 12:01pm MYT today when now is before that today', () => {
    const now = new Date('2026-07-11T00:00:00.000Z'); // 08:00 MYT
    expect(nextFireTime(now)).toEqual(new Date('2026-07-11T04:01:00.000Z'));
  });

  it('rolls to tomorrow when now is exactly at the cutoff', () => {
    const now = new Date('2026-07-11T04:01:00.000Z'); // exactly 12:01pm MYT
    expect(nextFireTime(now)).toEqual(new Date('2026-07-12T04:01:00.000Z'));
  });

  it('returns today when now is one second before the cutoff', () => {
    const now = new Date('2026-07-11T04:00:59.000Z');
    expect(nextFireTime(now)).toEqual(new Date('2026-07-11T04:01:00.000Z'));
  });

  it('rolls to tomorrow when now is after the cutoff today', () => {
    const now = new Date('2026-07-11T10:00:00.000Z'); // 18:00 MYT
    expect(nextFireTime(now)).toEqual(new Date('2026-07-12T04:01:00.000Z'));
  });

  it('rolls across a month boundary', () => {
    const now = new Date('2026-07-31T10:00:00.000Z');
    expect(nextFireTime(now)).toEqual(new Date('2026-08-01T04:01:00.000Z'));
  });

  it('rolls across a year boundary', () => {
    const now = new Date('2026-12-31T10:00:00.000Z');
    expect(nextFireTime(now)).toEqual(new Date('2027-01-01T04:01:00.000Z'));
  });
});

describe('mytDateString', () => {
  it('returns the MYT calendar date for a UTC morning timestamp', () => {
    expect(mytDateString(new Date('2026-07-11T00:00:00.000Z'))).toBe('2026-07-11'); // 08:00 MYT
  });

  it('rolls the date forward for a UTC evening timestamp (past MYT midnight)', () => {
    expect(mytDateString(new Date('2026-07-11T20:00:00.000Z'))).toBe('2026-07-12'); // 04:00 MYT next day
  });
});

describe('missedToday', () => {
  it('is false when lastRunDate is already today (MYT)', () => {
    const now = new Date('2026-07-11T10:00:00.000Z'); // 18:00 MYT
    expect(missedToday(now, '2026-07-11')).toBe(false);
  });

  it('is false when lastRunDate is null but the noon cutoff has not passed yet today', () => {
    const now = new Date('2026-07-11T00:00:00.000Z'); // 08:00 MYT
    expect(missedToday(now, null)).toBe(false);
  });

  it('is true when lastRunDate is null and the noon cutoff has already passed today', () => {
    const now = new Date('2026-07-11T10:00:00.000Z'); // 18:00 MYT
    expect(missedToday(now, null)).toBe(true);
  });

  it('is true when lastRunDate is yesterday and the noon cutoff has already passed today', () => {
    const now = new Date('2026-07-11T10:00:00.000Z'); // 18:00 MYT
    expect(missedToday(now, '2026-07-10')).toBe(true);
  });

  it('is false when lastRunDate is yesterday but the noon cutoff has not passed yet today', () => {
    const now = new Date('2026-07-11T00:00:00.000Z'); // 08:00 MYT
    expect(missedToday(now, '2026-07-10')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w backend -- dailyTrigger`
Expected: FAIL — `Cannot find module '../src/scheduler/dailyTrigger.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/scheduler/dailyTrigger.ts
const FIRE_UTC_HOUR = 4; // 12:01pm MYT (UTC+8, no DST) is 04:01 UTC
const FIRE_MINUTE = 1;

// The next 12:01pm Malaysia-time instant strictly after `now`.
export function nextFireTime(now: Date): Date {
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    FIRE_UTC_HOUR, FIRE_MINUTE, 0, 0,
  ));
  if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1);
  return candidate;
}

// Today's calendar date in Malaysia time, as YYYY-MM-DD. Malaysia is UTC+8 year-round
// (no DST), so shifting by +8h and reading UTC fields gives the correct local date.
export function mytDateString(now: Date): string {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

// True when today's 12:01pm MYT run hasn't happened yet and that cutoff has already passed —
// used on startup to catch up immediately instead of waiting for tomorrow.
export function missedToday(now: Date, lastRunDate: string | null): boolean {
  const today = mytDateString(now);
  if (lastRunDate === today) return false;
  const cutoff = new Date(`${today}T12:01:00+08:00`);
  return now >= cutoff;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w backend -- dailyTrigger`
Expected: PASS (17 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/scheduler/dailyTrigger.ts backend/test/dailyTrigger.test.ts
git commit -m "feat: add pure date-math for the daily 12:01pm MYT trigger"
```

---

### Task 2: `dailyRunState.ts` — last-run-date persistence

**Files:**
- Create: `backend/src/scheduler/dailyRunState.ts`
- Test: `backend/test/dailyRunState.test.ts`

**Interfaces:**
- Produces: `createDailyRunStateStore(dataDir: string): { load(): Promise<string | null>; save(date: string): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/dailyRunState.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDailyRunStateStore } from '../src/scheduler/dailyRunState.js';

describe('createDailyRunStateStore', () => {
  it('load() returns null when no state file exists yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tms-daily-'));
    const store = createDailyRunStateStore(dir);
    expect(await store.load()).toBeNull();
  });

  it('save() then load() round-trips the date', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tms-daily-'));
    const store = createDailyRunStateStore(dir);
    await store.save('2026-07-11');
    expect(await store.load()).toBe('2026-07-11');
  });

  it('save() overwrites a previously saved date', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tms-daily-'));
    const store = createDailyRunStateStore(dir);
    await store.save('2026-07-10');
    await store.save('2026-07-11');
    expect(await store.load()).toBe('2026-07-11');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w backend -- dailyRunState`
Expected: FAIL — `Cannot find module '../src/scheduler/dailyRunState.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/scheduler/dailyRunState.ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface DailyRunState {
  lastRunDate: string | null;
}

export function createDailyRunStateStore(dataDir: string) {
  const filePath = join(dataDir, 'daily-schedule.json');
  return {
    async load(): Promise<string | null> {
      try {
        const raw = JSON.parse(await readFile(filePath, 'utf8')) as DailyRunState;
        return raw.lastRunDate ?? null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async save(date: string): Promise<void> {
      await mkdir(dataDir, { recursive: true });
      const tmp = `${filePath}.tmp`;
      const state: DailyRunState = { lastRunDate: date };
      await writeFile(tmp, JSON.stringify(state), 'utf8');
      await rename(tmp, filePath);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w backend -- dailyRunState`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/scheduler/dailyRunState.ts backend/test/dailyRunState.test.ts
git commit -m "feat: add last-run-date persistence for the daily scheduler"
```

---

### Task 3: `ScrapeManager.waitUntilIdle()`

**Files:**
- Modify: `backend/src/scrape/manager.ts`
- Test: `backend/test/manager.test.ts`

**Interfaces:**
- Consumes: existing `ScrapeManager` internals (`this.running`, the `finally` block in `runToCompletion`).
- Produces: `ScrapeManager.waitUntilIdle(): Promise<void>` — resolves immediately if idle, otherwise resolves once the in-flight run (however it was started — `start()` or a direct `runToCompletion()` call) finishes.

- [ ] **Step 1: Write the failing test**

Add to `backend/test/manager.test.ts`, inside the existing `describe('ScrapeManager', ...)` block (after the `cancel() returns false when nothing is running` test):

```ts
  it('waitUntilIdle resolves immediately when idle', async () => {
    const repo = await freshRepo();
    const mgr = new ScrapeManager([], repo, { now: NOW });
    await expect(mgr.waitUntilIdle()).resolves.toBeUndefined();
  });

  it('waitUntilIdle resolves only after an in-flight run completes', async () => {
    const repo = await freshRepo();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const adapter = fakeAdapter(async () => gate);
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    mgr.start('open');
    let resolved = false;
    const waiter = mgr.waitUntilIdle().then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    release();
    await waiter;
    expect(resolved).toBe(true);
    expect(mgr.status().state).toBe('done');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w backend -- manager`
Expected: FAIL — `mgr.waitUntilIdle is not a function`

- [ ] **Step 3: Write minimal implementation**

In `backend/src/scrape/manager.ts`, add a field alongside the existing two (near the top of the class, `manager.ts:16-18`):

```ts
  private current: ScrapeStatus = { state: 'idle' };
  private running = false;
  private cancelRequested = false;
  private idleWaiters: Array<() => void> = [];
```

Add a new public method, next to `cancel()` (`manager.ts:37-41`):

```ts
  async waitUntilIdle(): Promise<void> {
    if (!this.running) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }
```

Update the `finally` block in `runToCompletion` (`manager.ts:117-119`) to resolve any waiters when the run ends:

```ts
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w backend -- manager`
Expected: PASS (all manager tests, including the 2 new ones — 17 total)

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrape/manager.ts backend/test/manager.test.ts
git commit -m "feat: add ScrapeManager.waitUntilIdle()"
```

---

### Task 4: `DailyScheduler` class

**Files:**
- Create: `backend/src/scheduler/DailyScheduler.ts`
- Test: `backend/test/DailyScheduler.test.ts`

**Interfaces:**
- Consumes: `nextFireTime(now: Date): Date` and `mytDateString(now: Date): string` and `missedToday(now: Date, lastRunDate: string | null): boolean` from Task 1 (`backend/src/scheduler/dailyTrigger.js`).
- Produces: `class DailyScheduler` with constructor `(deps: DailySchedulerDeps)`, `async start(): Promise<void>`, `stop(): void`. `DailySchedulerDeps` is `{ run: () => Promise<void>; loadLastRunDate: () => Promise<string | null>; saveLastRunDate: (date: string) => Promise<void>; now?: () => Date; setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout; clearTimeoutFn?: (handle: NodeJS.Timeout) => void; onError?: (err: unknown) => void }`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/DailyScheduler.test.ts
import { describe, expect, it, vi } from 'vitest';
import { DailyScheduler } from '../src/scheduler/DailyScheduler.js';

type FakeTimer = { fn: () => void; ms: number };

function fakeTimerFns() {
  const timers: FakeTimer[] = [];
  const cleared: unknown[] = [];
  let nextHandle = 1;
  return {
    timers,
    cleared,
    setTimeoutFn: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return nextHandle++ as unknown as NodeJS.Timeout;
    },
    clearTimeoutFn: (handle: NodeJS.Timeout) => { cleared.push(handle); },
  };
}

describe('DailyScheduler', () => {
  it('arms a timer for the next 12:01pm MYT fire time when today has already run', async () => {
    const clock = new Date('2026-07-11T00:00:00.000Z'); // 08:00 MYT, before noon
    const { timers, setTimeoutFn, clearTimeoutFn } = fakeTimerFns();
    const scheduler = new DailyScheduler({
      run: vi.fn(async () => {}),
      loadLastRunDate: async () => '2026-07-11', // already ran today
      saveLastRunDate: vi.fn(async () => {}),
      now: () => clock,
      setTimeoutFn,
      clearTimeoutFn,
    });
    await scheduler.start();
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(new Date('2026-07-11T04:01:00.000Z').getTime() - clock.getTime());
  });

  it('fires immediately on start when catch-up is needed (missed today, already past noon MYT)', async () => {
    const clock = new Date('2026-07-11T10:00:00.000Z'); // 18:00 MYT, after noon
    const run = vi.fn(async () => {});
    const saveLastRunDate = vi.fn(async () => {});
    const { timers, setTimeoutFn, clearTimeoutFn } = fakeTimerFns();
    const scheduler = new DailyScheduler({
      run,
      loadLastRunDate: async () => '2026-07-10', // last ran yesterday
      saveLastRunDate,
      now: () => clock,
      setTimeoutFn,
      clearTimeoutFn,
    });
    await scheduler.start();
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget run() settle
    expect(saveLastRunDate).toHaveBeenCalledWith('2026-07-11');
    expect(run).toHaveBeenCalledTimes(1);
    // Tomorrow's timer was armed immediately, independent of run() completing.
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(new Date('2026-07-12T04:01:00.000Z').getTime() - clock.getTime());
  });

  it('on a normal scheduled fire, saves the date and arms tomorrow before run() resolves', async () => {
    const clock = new Date('2026-07-11T00:00:00.000Z'); // 08:00 MYT, before noon
    let releaseRun!: () => void;
    const gate = new Promise<void>((r) => { releaseRun = r; });
    const run = vi.fn(async () => gate);
    const saveLastRunDate = vi.fn(async () => {});
    const { timers, setTimeoutFn, clearTimeoutFn } = fakeTimerFns();
    const scheduler = new DailyScheduler({
      run,
      loadLastRunDate: async () => null,
      saveLastRunDate,
      now: () => clock,
      setTimeoutFn,
      clearTimeoutFn,
    });
    await scheduler.start();
    expect(timers).toHaveLength(1); // today's 12:01pm timer armed
    timers[0]!.fn(); // simulate the timer firing
    await new Promise((r) => setTimeout(r, 0));
    expect(saveLastRunDate).toHaveBeenCalledWith('2026-07-11');
    expect(run).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(2); // tomorrow's timer armed even though run() hasn't resolved yet
    releaseRun();
  });

  it('logs via onError and still arms the next day when run() throws', async () => {
    const clock = new Date('2026-07-11T00:00:00.000Z');
    const onError = vi.fn();
    const { timers, setTimeoutFn, clearTimeoutFn } = fakeTimerFns();
    const scheduler = new DailyScheduler({
      run: vi.fn(async () => { throw new Error('scrape failed'); }),
      loadLastRunDate: async () => null,
      saveLastRunDate: vi.fn(async () => {}),
      now: () => clock,
      setTimeoutFn,
      clearTimeoutFn,
      onError,
    });
    await scheduler.start();
    timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(timers).toHaveLength(2); // next day's timer still armed
  });

  it('stop() clears the pending timer', async () => {
    const clock = new Date('2026-07-11T00:00:00.000Z');
    const { cleared, setTimeoutFn, clearTimeoutFn } = fakeTimerFns();
    const scheduler = new DailyScheduler({
      run: vi.fn(async () => {}),
      loadLastRunDate: async () => null,
      saveLastRunDate: vi.fn(async () => {}),
      now: () => clock,
      setTimeoutFn,
      clearTimeoutFn,
    });
    await scheduler.start();
    scheduler.stop();
    expect(cleared).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w backend -- DailyScheduler`
Expected: FAIL — `Cannot find module '../src/scheduler/DailyScheduler.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/scheduler/DailyScheduler.ts
import { missedToday, mytDateString, nextFireTime } from './dailyTrigger.js';

export interface DailySchedulerDeps {
  run: () => Promise<void>;
  loadLastRunDate: () => Promise<string | null>;
  saveLastRunDate: (date: string) => Promise<void>;
  now?: () => Date;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  onError?: (err: unknown) => void;
}

export class DailyScheduler {
  private readonly now: () => Date;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimeoutFn: (handle: NodeJS.Timeout) => void;
  private readonly onError: (err: unknown) => void;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: DailySchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));
    this.onError = deps.onError ?? ((err) => console.error('[daily] run failed:', err));
  }

  async start(): Promise<void> {
    const lastRunDate = await this.deps.loadLastRunDate();
    if (missedToday(this.now(), lastRunDate)) {
      this.fire();
    } else {
      this.armNext();
    }
  }

  stop(): void {
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }

  private armNext(): void {
    const delayMs = nextFireTime(this.now()).getTime() - this.now().getTime();
    this.timer = this.setTimeoutFn(() => this.fire(), delayMs);
  }

  // Schedules tomorrow's fire immediately (wall-clock based), then runs today's work in the
  // background — so a slow run() (e.g. waiting out a concurrent scrape) never delays tomorrow's
  // trigger.
  private fire(): void {
    const today = mytDateString(this.now());
    this.armNext();
    void this.runOnce(today);
  }

  private async runOnce(today: string): Promise<void> {
    try {
      await this.deps.saveLastRunDate(today);
      await this.deps.run();
    } catch (err) {
      this.onError(err);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w backend -- DailyScheduler`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/scheduler/DailyScheduler.ts backend/test/DailyScheduler.test.ts
git commit -m "feat: add DailyScheduler for the 12:01pm MYT daily trigger"
```

---

### Task 5: Wire into `index.ts`, remove the old sweep

**Files:**
- Modify: `backend/src/index.ts:66-85` (delete), add new wiring near the end of `main()`.

**Interfaces:**
- Consumes: `DailyScheduler` and `DailySchedulerDeps` from Task 4 (`backend/src/scheduler/DailyScheduler.js`), `createDailyRunStateStore` from Task 2 (`backend/src/scheduler/dailyRunState.js`), `repo.reconcileStaleOpen()` / `repo.flush()` (existing, `backend/src/storage/repository.ts`), `manager.waitUntilIdle()` from Task 3 and `manager.start('open')` (existing, `backend/src/scrape/manager.ts`).

This task has no dedicated unit test — `index.ts` is the process entrypoint and has no existing test coverage (consistent with the current codebase; startup wiring is exercised indirectly via `startupPolicy.test.ts` and manual verification). Verification is: full test suite still passes, plus a manual smoke check.

- [ ] **Step 1: Remove the old sweep and add the new scheduler wiring**

In `backend/src/index.ts`, add two imports at the top (after the existing imports, before `const PORT = ...`):

```ts
import { DailyScheduler } from './scheduler/DailyScheduler.js';
import { createDailyRunStateStore } from './scheduler/dailyRunState.js';
```

Delete the entire block at `backend/src/index.ts:66-85`:

```ts
  const rawSweepIntervalHours = Number(process.env.STALE_SWEEP_INTERVAL_HOURS);
  const sweepIntervalHours = rawSweepIntervalHours > 0 ? rawSweepIntervalHours : 6;
  // Node's setInterval uses a 32-bit signed int for the delay; anything larger fires almost
  // immediately instead of "far in the future" — clamp so a misconfigured (or Infinity) env
  // var can't turn this into a tight loop.
  const MAX_SETINTERVAL_DELAY_MS = 2 ** 31 - 1;
  const sweepDelayMs = Math.min(sweepIntervalHours * 60 * 60 * 1000, MAX_SETINTERVAL_DELAY_MS);
  setInterval(() => {
    void (async () => {
      try {
        const count = repo.reconcileStaleOpen();
        if (count > 0) {
          console.log(`[sweep] reconciled ${count} stale open tender(s)`);
          await repo.flush();
        }
      } catch (err) {
        console.error('[sweep] reconciliation failed:', err);
      }
    })();
  }, sweepDelayMs).unref();
```

Replace it with:

```ts
  const dailyRunState = createDailyRunStateStore(DATA_DIR);
  const dailyScheduler = new DailyScheduler({
    run: async () => {
      const staleCount = repo.reconcileStaleOpen();
      if (staleCount > 0) {
        console.log(`[daily] reconciled ${staleCount} stale open tender(s)`);
        await repo.flush();
      }
      await manager.waitUntilIdle();
      if (!manager.start('open', { sourceName: 'myprocurement' })) {
        console.log("[daily] scrape already in progress after waiting — skipping today's auto-scrape");
      }
    },
    loadLastRunDate: () => dailyRunState.load(),
    saveLastRunDate: (date) => dailyRunState.save(date),
  });
  await dailyScheduler.start();
```

- [ ] **Step 2: Run the full backend test suite to make sure nothing broke**

Run: `npm run test -w backend`
Expected: PASS (all suites, including the new ones from Tasks 1–4)

- [ ] **Step 3: Manual smoke check**

Run: `npm run dev -w backend`
Expected console output: `backend listening on :3001` with no errors. No `[sweep]` log lines appear (that code path no longer exists). If you want to see the catch-up path fire immediately, temporarily delete `backend/data/daily-schedule.json` (if present) before starting — since there's no recorded last-run-date and the real current time is past 12:01pm MYT, `[daily] ...` log lines should appear shortly after startup, and a scrape should start (visible via the existing `/api/scrape/status` endpoint or console scrape logs).

- [ ] **Step 4: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat: replace periodic stale sweep with daily 12:01pm MYT close-and-rescrape"
```

---

## Plan Self-Review Notes

- **Spec coverage:** reconcile-then-wait-then-scrape behavior (Task 4 + 5), catch-up on startup (Task 1 `missedToday` + Task 4), next-day timer armed independent of `run()` duration (Task 4, explicitly tested), `waitUntilIdle` on the manager (Task 3), state persistence (Task 2), removal of the old sweep (Task 5). All spec sections have a corresponding task.
- **No placeholders:** every step has complete, runnable code.
- **Type consistency:** `DailySchedulerDeps` fields (`run`, `loadLastRunDate`, `saveLastRunDate`, `now`, `setTimeoutFn`, `clearTimeoutFn`, `onError`) are used identically in Task 4's implementation and tests; `createDailyRunStateStore(dataDir).load()/.save(date)` matches its use in Task 5; `manager.waitUntilIdle()` matches its use in Task 5's `run` callback.
