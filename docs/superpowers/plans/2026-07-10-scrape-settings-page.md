# Per-Source Scrape Management & Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the startup-policy bug where a brand-new data source's current-year data never
gets scheduled automatically (because the old policy decided scope for every adapter
combined, not per adapter), add scrape cancellation, and replace the single global
"Rescrape" button with a per-source Settings page (`/settings` → Data Sources section: last
fetched, Fetch open / Full refresh / Cancel per source).

**Architecture:** `decideStartupPolicy` becomes a pure per-adapter function; `index.ts`
calls it once per registered adapter and runs each one's own startup need sequentially in
the background (server still serves immediately). `ScrapeManager` gains an optional
`sourceName` filter on `start`/`runToCompletion`, a `cancel()` method with cooperative
checkpoint-based cancellation (both adapters check `opts.isCancelled` between jobs/pages),
and a `listSources()` reporting method. Three API changes expose this:
`GET /api/sources`, `POST /api/scrape` (now takes `{ source?, scope? }`), and
`POST /api/scrape/cancel`. The frontend gets a new Settings page and navbar link;
`ScrapeBanner` and the header Rescrape button are removed.

**Tech Stack:** TypeScript, Express, Zod, Vitest, supertest, React, React Query, MSW,
Testing Library.

## Global Constraints

- Write the failing test FIRST for every change; confirm it fails for the right reason
  before implementing.
- Commit immediately after each task goes green. Never commit red.
- `POST /api/scrape` must stay backward compatible: no body / no `source` / no `scope`
  behaves exactly as it does today (open scope, every adapter).
- Only one scrape runs at a time app-wide (single shared lock) — this plan does not add
  concurrent per-source scraping, only per-source *targeting* of the existing single lock.
- Cancellation is cooperative and checked between jobs/pages, not mid-HTTP-request — an
  in-flight page/year fetch is allowed to finish.
- Node 22, TypeScript, ESM everywhere (`.js` extensions on relative imports).
- Follow existing code style exactly: single quotes, semicolons, existing test patterns
  (`fakeAdapter`/`waitUntil` in `manager.test.ts`, `server.use(...)` overrides with MSW,
  `QueryClientProvider` + `render` wrapper functions in frontend tests).
- Tests must never hit any real external site.

---

### Task 1: `decideStartupPolicy` becomes a per-adapter function

**Files:**
- Modify: `backend/src/startupPolicy.ts` (whole file)
- Modify: `backend/test/startupPolicy.test.ts` (whole file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `decideStartupPolicy(deps: StartupPolicyDeps): StartupPolicyResult`, now called
  **once per adapter** (previously once for the whole app). New `StartupPolicyDeps` shape:
  `{ hasSource: boolean; mergedIsEmpty: boolean; archiveJobNames: string[];
  completedArchiveJobs: string[] }` (all single-adapter facts except `mergedIsEmpty`, which
  is a whole-app fact passed in unchanged per call). `StartupPolicyResult` shape
  (`{ needsFull, needsBackfill, emptyStoreMismatch }`) is unchanged. Task 3 calls this once
  per registered adapter.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `backend/test/startupPolicy.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { decideStartupPolicy } from '../src/startupPolicy.js';

const ARCHIVE_JOBS = ['closed-quotation', 'closed-tender', 'closed-requisition'];

describe('decideStartupPolicy', () => {
  it('needs a full scrape when this adapter has never run', () => {
    const result = decideStartupPolicy({
      hasSource: false,
      mergedIsEmpty: true,
      archiveJobNames: ARCHIVE_JOBS,
      completedArchiveJobs: [],
    });
    expect(result.needsFull).toBe(true);
    expect(result.emptyStoreMismatch).toBe(false); // never ran, so nothing to mismatch
  });

  it('forces a full rescrape when the merged store is empty despite this adapter reporting prior completion (the original bug)', () => {
    const result = decideStartupPolicy({
      hasSource: true,
      mergedIsEmpty: true,
      archiveJobNames: ARCHIVE_JOBS,
      completedArchiveJobs: ARCHIVE_JOBS,
    });
    expect(result.needsFull).toBe(true);
    expect(result.emptyStoreMismatch).toBe(true);
  });

  it('does not need a full scrape or backfill when this adapter has run and every archive job has completed', () => {
    const result = decideStartupPolicy({
      hasSource: true,
      mergedIsEmpty: false,
      archiveJobNames: ARCHIVE_JOBS,
      completedArchiveJobs: ARCHIVE_JOBS,
    });
    expect(result.needsFull).toBe(false);
    expect(result.needsBackfill).toBe(false);
    expect(result.emptyStoreMismatch).toBe(false);
  });

  it('needs only a backfill resume when this adapter has data but no archive job has completed yet', () => {
    const result = decideStartupPolicy({
      hasSource: true,
      mergedIsEmpty: false,
      archiveJobNames: ARCHIVE_JOBS,
      completedArchiveJobs: [],
    });
    expect(result.needsFull).toBe(false);
    expect(result.needsBackfill).toBe(true);
    expect(result.emptyStoreMismatch).toBe(false);
  });

  it('needs a backfill resume when a NEW archive job kind was added after a prior backfill already completed', () => {
    const result = decideStartupPolicy({
      hasSource: true,
      mergedIsEmpty: false,
      archiveJobNames: [...ARCHIVE_JOBS, 'closed-quotation-results', 'closed-tender-results'],
      completedArchiveJobs: ARCHIVE_JOBS,
    });
    expect(result.needsFull).toBe(false);
    expect(result.needsBackfill).toBe(true);
    expect(result.emptyStoreMismatch).toBe(false);
  });

  it('a brand-new adapter needs a full scrape even when the merged store is non-empty because another adapter already has data (the startup bug this fixes)', () => {
    // Reproduces the real bug: e.g. myprocurement already has data (mergedIsEmpty=false),
    // but a newly added adapter (e.g. span) has never run itself (hasSource=false). It must
    // still get needsFull=true, independent of any other adapter's state.
    const result = decideStartupPolicy({
      hasSource: false,
      mergedIsEmpty: false,
      archiveJobNames: ['closed-2025', 'closed-2024'],
      completedArchiveJobs: [],
    });
    expect(result.needsFull).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- test/startupPolicy.test.ts`
Expected: FAIL — `decideStartupPolicy` still expects the old `{ adapterNames, hasSource,
mergedCount, getArchiveJobNames, getCompletedArchiveJobs }` shape, so every call in the new
test file is a type/shape mismatch and the old logic won't produce these results.

- [ ] **Step 3: Rewrite the implementation**

Replace the full contents of `backend/src/startupPolicy.ts` with:

```ts
// Pure decision logic for the startup scrape policy (see index.ts's `main()`), extracted so
// it can be unit-tested directly — index.ts itself is process-bootstrap code excluded from
// the coverage gate (see vitest.config.ts).
//
// Called ONCE PER ADAPTER (not once for the whole app): a brand-new adapter must always get
// its own full scrape at startup, regardless of what any other already-bootstrapped adapter
// has done. See docs/superpowers/specs/2026-07-10-scrape-settings-page-design.md.

export interface StartupPolicyDeps {
  /** Whether THIS adapter has ever completed any scrape (has a meta.json entry). */
  hasSource: boolean;
  /** Whether the whole merged tender store is empty — a fact shared across every adapter. */
  mergedIsEmpty: boolean;
  /** This adapter's own full set of closed/archive job names (ScraperAdapter.archiveJobNames). */
  archiveJobNames: string[];
  /** This adapter's own archive job names that have fully paginated at least once. */
  completedArchiveJobs: string[];
}

export interface StartupPolicyResult {
  needsFull: boolean;
  needsBackfill: boolean;
  // true when this adapter's meta claims prior completion, yet the merged store is empty —
  // e.g. stale/partial data dir. Surfaced so callers can log a warning instead of self-healing
  // silently.
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend -- test/startupPolicy.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/startupPolicy.ts backend/test/startupPolicy.test.ts
git commit -m "fix(backend): decide startup scrape policy per adapter, not combined"
```

---

### Task 2: `ScrapeManager` gains a source-name filter and `listSources()`

**Files:**
- Modify: `backend/src/scrape/manager.ts`
- Modify: `backend/test/manager.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `start(scope: ScrapeScope, opts?: { sourceName?: string }): boolean` and
  `runToCompletion(scope: ScrapeScope, opts?: { sourceName?: string }): Promise<void>` —
  when `sourceName` is given, only the matching adapter (by `.name`) runs; omitted means
  every adapter, unchanged from today. New `listSources(): Array<{ name: string;
  lastScrapedAt: string | null; lastArchiveBackfillAt: string | null; total: number }>`.
  Task 3 (startup orchestration) and Task 6 (API endpoints) both depend on this.

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the existing `describe('ScrapeManager', ...)` block in
`backend/test/manager.test.ts` (anywhere after the existing tests is fine):

```ts
  it('runs only the named adapter when sourceName is given, leaving other adapters untouched', async () => {
    const repo = await freshRepo();
    const calls: string[] = [];
    const adapterA: ScraperAdapter = { name: 'a', scrape: async () => { calls.push('a'); }, archiveJobNames: () => [] };
    const adapterB: ScraperAdapter = { name: 'b', scrape: async () => { calls.push('b'); }, archiveJobNames: () => [] };
    const mgr = new ScrapeManager([adapterA, adapterB], repo, { now: NOW });
    await mgr.runToCompletion('open', { sourceName: 'b' });
    expect(calls).toEqual(['b']);
  });

  it('listSources reports name, lastScrapedAt, lastArchiveBackfillAt, and total per adapter', async () => {
    const repo = await freshRepo();
    const adapter = fakeAdapter(async (_s, hooks) => { await hooks.onBatch([makePatch(1)]); });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    expect(mgr.listSources()).toEqual([{ name: 'fake', lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 }]);
    await mgr.runToCompletion('open');
    expect(mgr.listSources()).toEqual([{ name: 'fake', lastScrapedAt: NOW(), lastArchiveBackfillAt: null, total: 1 }]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- test/manager.test.ts`
Expected: FAIL — `runToCompletion` doesn't accept a second argument yet (the `sourceName`
filter has no effect, both adapters run), and `listSources` doesn't exist.

- [ ] **Step 3: Implement the filter and `listSources()`**

In `backend/src/scrape/manager.ts`, change the `start` and `runToCompletion` signatures and
add the adapter filter. Change:

```ts
  start(scope: ScrapeScope): boolean {
    if (this.running) return false;
    void this.runToCompletion(scope);
    return true;
  }

  async runToCompletion(scope: ScrapeScope): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.current = { state: 'running' };
    const now = this.opts.now ?? (() => new Date().toISOString());
    const flushEvery =
      this.opts.flushEveryPages ??
      (scope === 'open' ? (this.opts.flushEveryPagesOpen ?? 10) : (this.opts.flushEveryPagesArchive ?? 50));

    try {
      for (const adapter of this.adapters) {
```

to:

```ts
  start(scope: ScrapeScope, opts: { sourceName?: string } = {}): boolean {
    if (this.running) return false;
    void this.runToCompletion(scope, opts);
    return true;
  }

  async runToCompletion(scope: ScrapeScope, opts: { sourceName?: string } = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.current = { state: 'running' };
    const now = this.opts.now ?? (() => new Date().toISOString());
    const flushEvery =
      this.opts.flushEveryPages ??
      (scope === 'open' ? (this.opts.flushEveryPagesOpen ?? 10) : (this.opts.flushEveryPagesArchive ?? 50));
    const adapters = opts.sourceName ? this.adapters.filter((a) => a.name === opts.sourceName) : this.adapters;

    try {
      for (const adapter of adapters) {
```

(The rest of the `for` loop body is unchanged.)

Then add `listSources()` as a new public method, placed after `status()`:

```ts
  listSources(): Array<{ name: string; lastScrapedAt: string | null; lastArchiveBackfillAt: string | null; total: number }> {
    return this.adapters.map((a) => {
      const meta = this.repo.getMeta(a.name);
      return { name: a.name, lastScrapedAt: meta.lastScrapedAt, lastArchiveBackfillAt: meta.lastArchiveBackfillAt, total: meta.total };
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend -- test/manager.test.ts`
Expected: PASS (all tests, including the two new ones and every pre-existing test —
`opts.sourceName` defaults to nothing, so all existing single-argument
`runToCompletion(scope)`/`start(scope)` calls are unaffected).

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrape/manager.ts backend/test/manager.test.ts
git commit -m "feat(backend): scope ScrapeManager runs to one source, add listSources()"
```

---

### Task 3: `index.ts` — per-adapter startup orchestration

**Files:**
- Modify: `backend/src/index.ts` (whole `main()` body from `const adapters = [...]` down to
  the `createApp(...)` call)

**Interfaces:**
- Consumes: `decideStartupPolicy` (Task 1, new per-adapter signature);
  `manager.runToCompletion(scope, { sourceName })` (Task 2).
- Produces: nothing new — this is wiring. `index.ts` is excluded from the coverage gate and
  has no dedicated test file (same as before this plan) — verified by the full suite
  passing, not a new test.

- [ ] **Step 1: Rewrite the startup section**

In `backend/src/index.ts`, replace everything from the `const adapters = [` line down to
(and including) the closing of the `if (needsFull) { ... } else if (needsBackfill) { ... }`
block with:

```ts
  const adapters = [
    new MyProcurementAdapter(createPoliteFetcher()),
    new SpanAdapter(createPoliteFetcher({ responseType: 'text' })),
  ];
  const manager = new ScrapeManager(adapters, repo);

  // Startup scrape policy, decided PER ADAPTER (see startupPolicy.ts and
  // docs/superpowers/specs/2026-07-10-scrape-settings-page-design.md): a brand-new adapter
  // always gets its own full scrape, regardless of whether other adapters already have data.
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
      console.warn(
        `[startup] ${adapter.name}: merged tender store is empty but this source reports prior completion — forcing full rescrape`,
      );
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

The `import { decideStartupPolicy } from './startupPolicy.js';` import line at the top of
the file stays as-is (already present). The `createApp({ repo, manager }).listen(...)` call
that follows is unchanged, and still runs immediately — the startup scrape plan above is
kicked off with `void (...)`, not awaited, so the server keeps serving immediately
regardless of how long the background catch-up takes.

- [ ] **Step 2: Run the full test suite**

Run: `npm test -w backend`
Expected: PASS (all backend tests — this task has no dedicated test, verified by nothing
breaking).

- [ ] **Step 3: Commit**

```bash
git add backend/src/index.ts
git commit -m "fix(backend): run each adapter's own startup scrape independently"
```

---

### Task 4: `ScrapeManager` gains cancellation

**Files:**
- Modify: `backend/src/scrapers/types.ts` (add `isCancelled` to `ScrapeOptions`)
- Modify: `backend/src/scrape/manager.ts`
- Modify: `backend/test/manager.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ScrapeOptions.isCancelled?: () => boolean` (new field on the interface both
  adapters receive — Task 5 makes the real adapters honor it; this task's own test uses a
  fake adapter that reads it directly). `ScrapeManager.cancel(): boolean` — `false` if
  nothing is running, otherwise flags the current run to stop and returns `true`.
  `ScrapeStatus.state` gains `'cancelled'`.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `backend/test/manager.test.ts`:

```ts
  it("cancel() stops a running scrape before the next adapter, keeps flushed data, and reports state 'cancelled'", async () => {
    const repo = await freshRepo();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let sawCancelled: boolean | undefined;
    const adapterA: ScraperAdapter = {
      name: 'a',
      scrape: async (_s, hooks, opts) => {
        await hooks.onBatch([makePatch(1)]);
        await gate; // block here until the test releases it
        sawCancelled = opts?.isCancelled?.();
      },
      archiveJobNames: () => [],
    };
    const adapterB: ScraperAdapter = { name: 'b', scrape: async () => { throw new Error('b should never run'); }, archiveJobNames: () => [] };
    const mgr = new ScrapeManager([adapterA, adapterB], repo, { now: NOW, flushEveryPages: 1 });
    mgr.start('open');
    await waitUntil(() => mgr.status().state === 'running');
    expect(mgr.cancel()).toBe(true);
    release();
    await waitUntil(() => mgr.status().state !== 'running');
    expect(mgr.status().state).toBe('cancelled');
    expect(sawCancelled).toBe(true);
    expect(repo.getAll()).toHaveLength(1); // flushed batch survived
    expect(repo.getMeta('a').lastScrapedAt).toBeNull(); // not stamped, run didn't finish
  });

  it('cancel() returns false when nothing is running', async () => {
    const repo = await freshRepo();
    const mgr = new ScrapeManager([], repo, { now: NOW });
    expect(mgr.cancel()).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- test/manager.test.ts`
Expected: FAIL — `mgr.cancel` doesn't exist yet.

- [ ] **Step 3: Add `isCancelled` to the options type**

In `backend/src/scrapers/types.ts`, change:

```ts
export interface ScrapeOptions {
  /** Closed/archive job names to skip (already completed in a prior backfill run). Open jobs are never skipped. */
  skipJobNames?: Set<string>;
}
```

to:

```ts
export interface ScrapeOptions {
  /** Closed/archive job names to skip (already completed in a prior backfill run). Open jobs are never skipped. */
  skipJobNames?: Set<string>;
  /** Adapters check this between jobs/pages and stop (returning normally, not throwing) when it reports true. */
  isCancelled?: () => boolean;
}
```

- [ ] **Step 4: Implement cancellation in `ScrapeManager`**

In `backend/src/scrape/manager.ts`, add a `cancelRequested` field next to `running`:

```ts
  private current: ScrapeStatus = { state: 'idle' };
  private running = false;
  private cancelRequested = false;
```

In `runToCompletion`, reset the flag at the start (next to `this.running = true;`):

```ts
    if (this.running) return;
    this.running = true;
    this.cancelRequested = false;
    this.current = { state: 'running' };
```

Pass `isCancelled` into the adapter's options (alongside the existing `skipJobNames`) —
change the final argument of the `adapter.scrape(...)` call from
`{ skipJobNames: completedArchiveJobs }` to:

```ts
          { skipJobNames: completedArchiveJobs, isCancelled: () => this.cancelRequested },
```

Then change the loop and its surrounding try block from:

```ts
    try {
      for (const adapter of adapters) {
        let pagesSinceFlush = 0;
```

to:

```ts
    try {
      for (const adapter of adapters) {
        if (this.cancelRequested) break;
        let pagesSinceFlush = 0;
```

And change the per-adapter post-processing (after `await adapter.scrape(...)`) from:

```ts
        await this.repo.flush();
        const stamp: Parameters<TenderRepository['setMeta']>[1] = {
          lastScrapedAt: now(),
          total: this.repo.getSourceCount(adapter.name),
        };
        if (scope === 'all' || scope === 'archive') stamp.lastArchiveBackfillAt = now();
        await this.repo.setMeta(adapter.name, stamp);
      }
      this.current = { state: 'done' };
```

to:

```ts
        await this.repo.flush();
        if (this.cancelRequested) break; // run didn't finish — don't stamp meta for this adapter
        const stamp: Parameters<TenderRepository['setMeta']>[1] = {
          lastScrapedAt: now(),
          total: this.repo.getSourceCount(adapter.name),
        };
        if (scope === 'all' || scope === 'archive') stamp.lastArchiveBackfillAt = now();
        await this.repo.setMeta(adapter.name, stamp);
      }
      this.current = this.cancelRequested ? { state: 'cancelled' } : { state: 'done' };
```

Finally, add the `cancel()` method (placed after `status()`):

```ts
  cancel(): boolean {
    if (!this.running) return false;
    this.cancelRequested = true;
    return true;
  }
```

And update `ScrapeStatus` at the top of the file:

```ts
export interface ScrapeStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w backend -- test/manager.test.ts`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 6: Commit**

```bash
git add backend/src/scrapers/types.ts backend/src/scrape/manager.ts backend/test/manager.test.ts
git commit -m "feat(backend): add ScrapeManager.cancel() with cooperative cancellation"
```

---

### Task 5: Both adapters honor `opts.isCancelled`

**Files:**
- Modify: `backend/src/scrapers/myprocurement/adapter.ts`
- Modify: `backend/src/scrapers/span/adapter.ts`
- Modify: `backend/test/adapter.test.ts`
- Modify: `backend/test/spanAdapter.test.ts`

**Interfaces:**
- Consumes: `ScrapeOptions.isCancelled` (Task 4).
- Produces: both adapters now check `opts.isCancelled?.()` and return early (without
  throwing) instead of starting the next page/job when it reports `true`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/adapter.test.ts`, inside `describe('MyProcurementAdapter', ...)`:

```ts
  it('stops before the next page when isCancelled reports true, without throwing', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return pageResponse([page], 3); // 3 pages available, so an early stop is observable
    });
    const adapter = new MyProcurementAdapter(fetcher);
    let cancelAfterFirstBatch = false;
    const batches: TenderPatch[][] = [];
    await adapter.scrape('open', {
      onProgress: () => {},
      onBatch: async (t) => { batches.push(t); cancelAfterFirstBatch = true; },
    }, { isCancelled: () => cancelAfterFirstBatch });
    expect(fetcher).toHaveBeenCalledTimes(1); // only the very first page fetched before stopping
    expect(batches).toHaveLength(1);
  });
```

Add to `backend/test/spanAdapter.test.ts`, inside `describe('SpanAdapter — job model', ...)`:

```ts
  it('stops before the next year job when isCancelled reports true, without throwing', async () => {
    const fetcher = vi.fn(async () => pageHtml(1, 'REF/1'));
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    let cancelAfterFirst = false;
    const batches: TenderPatch[][] = [];
    await adapter.scrape('archive', {
      onProgress: () => {},
      onBatch: async (t) => { batches.push(t); cancelAfterFirst = true; },
    }, { isCancelled: () => cancelAfterFirst });
    expect(fetcher).toHaveBeenCalledTimes(1); // only the first (2025) year fetched before stopping
    expect(batches).toHaveLength(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- test/adapter.test.ts test/spanAdapter.test.ts`
Expected: FAIL — both adapters currently ignore `opts.isCancelled` entirely, so they keep
fetching every page/job (`fetcher` called far more than once).

- [ ] **Step 3: Implement the checks**

In `backend/src/scrapers/myprocurement/adapter.ts`, change the job loop from:

```ts
    for (const [jobIndex, job] of jobs.entries()) {
      const name = jobName(job);
      let page = 1;
      let lastPage = 1;
      do {
        const url = `${BASE_URL}?page=${page}&itemsPerPage=${ITEMS_PER_PAGE}&type=${job.type}&category=${job.category}`;
```

to:

```ts
    for (const [jobIndex, job] of jobs.entries()) {
      if (opts.isCancelled?.()) return;
      const name = jobName(job);
      let page = 1;
      let lastPage = 1;
      do {
        if (opts.isCancelled?.()) return;
        const url = `${BASE_URL}?page=${page}&itemsPerPage=${ITEMS_PER_PAGE}&type=${job.type}&category=${job.category}`;
```

In `backend/src/scrapers/span/adapter.ts`, change the job loop from:

```ts
    for (const [jobIndex, job] of jobs.entries()) {
      const name = jobName(job);
      const url = `${BASE_URL}/${job.year}`;
```

to:

```ts
    for (const [jobIndex, job] of jobs.entries()) {
      if (opts.isCancelled?.()) return;
      const name = jobName(job);
      const url = `${BASE_URL}/${job.year}`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend -- test/adapter.test.ts test/spanAdapter.test.ts`
Expected: PASS (both new tests, and every pre-existing test in both files).

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrapers/myprocurement/adapter.ts backend/src/scrapers/span/adapter.ts backend/test/adapter.test.ts backend/test/spanAdapter.test.ts
git commit -m "feat(backend): both adapters honor cooperative cancellation"
```

---

### Task 6: API endpoints — `GET /api/sources`, source/scope-aware `POST /api/scrape`, `POST /api/scrape/cancel`

**Files:**
- Modify: `backend/src/api/app.ts`
- Modify: `backend/test/app.test.ts`

**Interfaces:**
- Consumes: `manager.listSources()` (Task 2), `manager.start(scope, { sourceName })`
  (Task 2), `manager.cancel()` (Task 4).
- Produces: `GET /api/sources`, `POST /api/scrape` body `{ source?: string, scope?: 'open' |
  'full' }`, `POST /api/scrape/cancel`. Task 7 (frontend client) consumes all three.

- [ ] **Step 1: Write the failing tests**

Add this helper near the top of `backend/test/app.test.ts` (after the existing `patch`
helper), and these four tests inside the existing `describe('API', ...)` block:

```ts
async function waitUntilNotRunning(app: ReturnType<typeof createApp>): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const res = await request(app).get('/api/scrape/status');
    if (res.body.state !== 'running') return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitUntilNotRunning: timed out');
}
```

```ts
  it('GET /api/sources returns name, lastScrapedAt, lastArchiveBackfillAt, and total per registered adapter', async () => {
    const fakeAdapter = { name: 'span', scrape: async () => {}, archiveJobNames: () => [] };
    const mgr = new ScrapeManager([fakeAdapter], repo);
    const app2 = createApp({ repo, manager: mgr });
    const res = await request(app2).get('/api/sources');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ name: 'span', lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 }]);
  });

  it('POST /api/scrape accepts source and scope=full, running only that adapter with the manager\'s "all" scope', async () => {
    const scrapedBy: string[] = [];
    let receivedScope: string | undefined;
    const adapterA = { name: 'a', scrape: async () => { scrapedBy.push('a'); }, archiveJobNames: () => [] };
    const adapterB = {
      name: 'b',
      scrape: async (scope: string) => { scrapedBy.push('b'); receivedScope = scope; },
      archiveJobNames: () => [],
    };
    const mgr = new ScrapeManager([adapterA, adapterB], repo);
    const app2 = createApp({ repo, manager: mgr });
    const res = await request(app2).post('/api/scrape').send({ source: 'b', scope: 'full' });
    expect(res.status).toBe(202);
    await waitUntilNotRunning(app2);
    expect(scrapedBy).toEqual(['b']);
    expect(receivedScope).toBe('all');
  });

  it('POST /api/scrape rejects an invalid scope value with 400', async () => {
    const res = await request(app).post('/api/scrape').send({ scope: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('POST /api/scrape/cancel cancels a running scrape (200) and 409s when nothing is running', async () => {
    const idle = await request(app).post('/api/scrape/cancel');
    expect(idle.status).toBe(409);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const blockingAdapter = { name: 'fake', scrape: async () => { await gate; }, archiveJobNames: () => [] };
    const blockingManager = new ScrapeManager([blockingAdapter], repo);
    const app2 = createApp({ repo, manager: blockingManager });
    await request(app2).post('/api/scrape');
    const res = await request(app2).post('/api/scrape/cancel');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: true });
    release();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- test/app.test.ts`
Expected: FAIL — `GET /api/sources` and `POST /api/scrape/cancel` don't exist (404), and
`POST /api/scrape` ignores the request body entirely.

- [ ] **Step 3: Implement the endpoints**

In `backend/src/api/app.ts`, add a body-parsing middleware and a request schema. Change:

```ts
const QuerySchema = z.object({
```

to (adding the new schema just before it):

```ts
const ScrapeRequestSchema = z.object({
  source: z.string().optional(),
  scope: z.enum(['open', 'full']).optional(),
});

const QuerySchema = z.object({
```

Change:

```ts
export function createApp(deps: { repo: TenderRepository; manager: ScrapeManager }) {
  const app = express();

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
```

to:

```ts
export function createApp(deps: { repo: TenderRepository; manager: ScrapeManager }) {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/sources', (_req, res) => {
    res.json(deps.manager.listSources());
  });
```

Change the existing scrape route from:

```ts
  app.post('/api/scrape', (_req, res) => {
    if (!deps.manager.start('open')) {
      return res.status(409).json({ error: 'scrape already running' });
    }
    res.status(202).json({ started: true });
  });

  app.get('/api/scrape/status', (_req, res) => {
    res.json(deps.manager.status());
  });
```

to:

```ts
  app.post('/api/scrape', (req, res) => {
    const parsed = ScrapeRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const scope = parsed.data.scope === 'full' ? 'all' : 'open';
    const started = deps.manager.start(scope, { sourceName: parsed.data.source });
    if (!started) return res.status(409).json({ error: 'scrape already running' });
    res.status(202).json({ started: true });
  });

  app.post('/api/scrape/cancel', (_req, res) => {
    if (!deps.manager.cancel()) return res.status(409).json({ error: 'nothing running' });
    res.json({ cancelled: true });
  });

  app.get('/api/scrape/status', (_req, res) => {
    res.json(deps.manager.status());
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend -- test/app.test.ts`
Expected: PASS (all new tests, and every pre-existing test — the existing "POST /api/scrape
starts an open-scope scrape" test sends no body at all, which `req.body ?? {}` and the
`scope` ternary both handle exactly as before: scope `'open'`, every adapter).

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/app.ts backend/test/app.test.ts
git commit -m "feat(backend): add /api/sources, source/scope-aware /api/scrape, /api/scrape/cancel"
```

---

### Task 7: Frontend API client — `fetchSources`, `cancelScrape`, source/scope-aware `triggerScrape`

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/test/mocks.ts`
- Modify: `frontend/src/test/client.test.ts`

**Interfaces:**
- Consumes: the three backend endpoints from Task 6.
- Produces: `ScrapeSource` type; `fetchSources(): Promise<ScrapeSource[]>`; `triggerScrape(params?: { source?: string; scope?: 'open' | 'full' }): Promise<void>` (params now
  optional, defaulting to `{}`, so existing no-arg callers keep working);
  `cancelScrape(): Promise<void>`. Also exports `defaultSources` (a mock fixture) and
  default MSW handlers for `/api/sources` and `/api/scrape/cancel`, which Task 8's
  `SettingsPage` tests rely on. Task 8 (`SettingsPage`) and Task 9 (removing
  `ScrapeBanner`) both depend on this.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/api/types.ts`, add (anywhere in the file):

```ts
export interface ScrapeSource {
  name: string;
  lastScrapedAt: string | null;
  lastArchiveBackfillAt: string | null;
  total: number;
}
```

And change `ScrapeStatus.state`'s union from
`'idle' | 'running' | 'done' | 'failed'` to `'idle' | 'running' | 'done' | 'failed' |
'cancelled'`.

In `frontend/src/test/mocks.ts`, add `ScrapeSource` to the type import at the top (change
`import type { Facets, ScrapeStatus, Tender, TenderPage } from '../api/types';` to include
`ScrapeSource`), then add this fixture and these two handlers (into the existing
`handlers` array):

```ts
export const defaultSources: ScrapeSource[] = [
  { name: 'myprocurement', lastScrapedAt: '2026-07-07T00:00:00.000Z', lastArchiveBackfillAt: '2026-07-01T00:00:00.000Z', total: 5775 },
  { name: 'span', lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 },
];
```

```ts
  http.get('/api/sources', () => HttpResponse.json(defaultSources)),
  http.post('/api/scrape/cancel', () => HttpResponse.json({ cancelled: true })),
```

Now add these three tests to `frontend/src/test/client.test.ts`, and update its import
line to include `cancelScrape` and `fetchSources`:

```ts
import { cancelScrape, fetchFacets, fetchScrapeStatus, fetchSources, fetchTender, fetchTenders, triggerScrape } from '../api/client';
```

```ts
  it('fetchSources returns the sources array', async () => {
    server.use(http.get('/api/sources', () => HttpResponse.json([
      { name: 'span', lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 },
    ])));
    const sources = await fetchSources();
    expect(sources).toEqual([{ name: 'span', lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 }]);
  });

  it('triggerScrape sends source and scope in the request body', async () => {
    let seenBody: unknown;
    server.use(http.post('/api/scrape', async ({ request }) => {
      seenBody = await request.json();
      return HttpResponse.json({ started: true }, { status: 202 });
    }));
    await triggerScrape({ source: 'span', scope: 'full' });
    expect(seenBody).toEqual({ source: 'span', scope: 'full' });
  });

  it('cancelScrape resolves on 200 and throws on 409', async () => {
    server.use(http.post('/api/scrape/cancel', () => HttpResponse.json({ cancelled: true })));
    await expect(cancelScrape()).resolves.toBeUndefined();
    server.use(http.post('/api/scrape/cancel', () => HttpResponse.json({ error: 'nothing running' }, { status: 409 })));
    await expect(cancelScrape()).rejects.toThrow('nothing running');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w frontend -- client`
Expected: FAIL — `fetchSources` and `cancelScrape` don't exist yet in `../api/client`.

- [ ] **Step 3: Implement the client functions**

In `frontend/src/api/client.ts`, change the import line from:

```ts
import type { Facets, ScrapeStatus, TenderDetail, TenderPage } from './types';
```

to:

```ts
import type { Facets, ScrapeSource, ScrapeStatus, TenderDetail, TenderPage } from './types';
```

Add `fetchSources` next to `fetchScrapeStatus`:

```ts
export function fetchSources(): Promise<ScrapeSource[]> {
  return getJson('/api/sources');
}
```

Change `triggerScrape` from:

```ts
export async function triggerScrape(): Promise<void> {
  const res = await fetch('/api/scrape', { method: 'POST' });
  if (res.status === 409) throw new Error('scrape already running');
  if (!res.ok) throw new Error(`scrape trigger failed: ${res.status}`);
}
```

to:

```ts
export async function triggerScrape(params: { source?: string; scope?: 'open' | 'full' } = {}): Promise<void> {
  const res = await fetch('/api/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (res.status === 409) throw new Error('scrape already running');
  if (!res.ok) throw new Error(`scrape trigger failed: ${res.status}`);
}

export async function cancelScrape(): Promise<void> {
  const res = await fetch('/api/scrape/cancel', { method: 'POST' });
  if (res.status === 409) throw new Error('nothing running');
  if (!res.ok) throw new Error(`cancel failed: ${res.status}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w frontend -- client`
Expected: PASS (all new tests, and the pre-existing `triggerScrape` tests — they call
`triggerScrape()` with no arguments, which now defaults to `{}`, sending `{}` as the JSON
body; the mocked handlers don't inspect the body, so they're unaffected).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/test/mocks.ts frontend/src/test/client.test.ts
git commit -m "feat(frontend): add fetchSources/cancelScrape, source/scope-aware triggerScrape"
```

---

### Task 8: Settings page (Data Sources) + navbar link

**Files:**
- Create: `frontend/src/pages/SettingsPage.tsx`
- Create: `frontend/src/test/SettingsPage.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/test/App.test.tsx`

**Interfaces:**
- Consumes: `fetchSources`, `fetchScrapeStatus`, `triggerScrape`, `cancelScrape` (Task 7).
- Produces: `SettingsPage` default export, route `/settings`. Task 9 (removing
  `ScrapeBanner`) comes after this so the replacement UI exists before the old one is
  deleted.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/test/SettingsPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import SettingsPage from '../pages/SettingsPage';
import { server } from './mocks';

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

describe('SettingsPage', () => {
  it('lists each source with its last-fetched info and two fetch buttons', async () => {
    renderSettings();
    const spanRow = await screen.findByRole('group', { name: 'span' });
    expect(within(spanRow).getByText(/never/)).toBeInTheDocument();
    expect(within(spanRow).getByRole('button', { name: /fetch open/i })).toBeInTheDocument();
    expect(within(spanRow).getByRole('button', { name: /full refresh/i })).toBeInTheDocument();
    const mpRow = screen.getByRole('group', { name: 'myprocurement' });
    expect(within(mpRow).getByText(/5775 tenders/)).toBeInTheDocument();
  });

  it("clicking Fetch open sends that row's source with scope=open", async () => {
    let seenBody: unknown;
    server.use(http.post('/api/scrape', async ({ request }) => {
      seenBody = await request.json();
      return HttpResponse.json({ started: true }, { status: 202 });
    }));
    renderSettings();
    const spanRow = await screen.findByRole('group', { name: 'span' });
    await userEvent.click(within(spanRow).getByRole('button', { name: /fetch open/i }));
    await waitFor(() => expect(seenBody).toEqual({ source: 'span', scope: 'open' }));
  });

  it("clicking Full refresh sends that row's source with scope=full", async () => {
    let seenBody: unknown;
    server.use(http.post('/api/scrape', async ({ request }) => {
      seenBody = await request.json();
      return HttpResponse.json({ started: true }, { status: 202 });
    }));
    renderSettings();
    const mpRow = await screen.findByRole('group', { name: 'myprocurement' });
    await userEvent.click(within(mpRow).getByRole('button', { name: /full refresh/i }));
    await waitFor(() => expect(seenBody).toEqual({ source: 'myprocurement', scope: 'full' }));
  });

  it("shows progress and a Cancel button on the running source's row, and disables every other row's buttons", async () => {
    server.use(http.get('/api/scrape/status', () => HttpResponse.json({
      state: 'running', source: 'span', job: 'open-2026', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1,
    })));
    renderSettings();
    const spanRow = await screen.findByRole('group', { name: 'span' });
    expect(within(spanRow).getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(within(spanRow).getByText(/open-2026/)).toBeInTheDocument();
    const mpRow = screen.getByRole('group', { name: 'myprocurement' });
    expect(within(mpRow).getByRole('button', { name: /fetch open/i })).toBeDisabled();
    expect(within(mpRow).getByRole('button', { name: /full refresh/i })).toBeDisabled();
  });

  it('clicking Cancel calls the cancel endpoint', async () => {
    let cancelCalled = false;
    server.use(
      http.get('/api/scrape/status', () => HttpResponse.json({
        state: 'running', source: 'span', job: 'open-2026', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1,
      })),
      http.post('/api/scrape/cancel', () => { cancelCalled = true; return HttpResponse.json({ cancelled: true }); }),
    );
    renderSettings();
    const spanRow = await screen.findByRole('group', { name: 'span' });
    await userEvent.click(within(spanRow).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(cancelCalled).toBe(true));
  });

  it("shows a failure message on the affected source's row", async () => {
    server.use(http.get('/api/scrape/status', () => HttpResponse.json({
      state: 'failed', source: 'span', error: 'fetch failed after 3 attempts: url',
    })));
    renderSettings();
    const spanRow = await screen.findByRole('group', { name: 'span' });
    expect(within(spanRow).getByText(/fetch failed after 3 attempts/)).toBeInTheDocument();
  });
});
```

Add this test to `frontend/src/test/App.test.tsx` inside `describe('App', ...)`, and add
`import userEvent from '@testing-library/user-event';` to its imports:

```ts
  it('renders a Settings link pinned in the nav, leading to the Settings page', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByText('Data Sources')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w frontend -- SettingsPage App`
Expected: FAIL — `../pages/SettingsPage` doesn't exist, and there's no Settings link or
route in `App.tsx` yet.

- [ ] **Step 3: Implement `SettingsPage`**

Create `frontend/src/pages/SettingsPage.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cancelScrape, fetchScrapeStatus, fetchSources, triggerScrape } from '../api/client';

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { data: sources } = useQuery({ queryKey: ['sources'], queryFn: fetchSources });
  const { data: status } = useQuery({
    queryKey: ['scrape-status'],
    queryFn: fetchScrapeStatus,
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 2000 : 10000),
  });

  const invalidateAfterRun = () => {
    queryClient.invalidateQueries({ queryKey: ['scrape-status'] });
    queryClient.invalidateQueries({ queryKey: ['sources'] });
    queryClient.invalidateQueries({ queryKey: ['tenders'] });
    queryClient.invalidateQueries({ queryKey: ['facets'] });
  };
  const fetchMutation = useMutation({ mutationFn: triggerScrape, onSettled: invalidateAfterRun });
  const cancelMutation = useMutation({ mutationFn: cancelScrape, onSettled: invalidateAfterRun });

  const running = status?.state === 'running';

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="font-semibold text-lg">Settings</h1>
      <section>
        <h2 className="font-semibold mb-3">Data Sources</h2>
        <div className="border border-[#e0e0e0] rounded-lg divide-y">
          {(sources ?? []).map((s) => {
            const isRunningThis = running && status?.source === s.name;
            return (
              <div key={s.name} role="group" aria-label={s.name} className="p-4 flex items-center justify-between gap-4">
                <div>
                  <div className="font-medium capitalize">{s.name}</div>
                  <div className="text-xs text-gray-500">
                    Last fetched: {s.lastScrapedAt ?? 'never'} · Full backfill: {s.lastArchiveBackfillAt ?? 'never'} · {s.total} tenders
                  </div>
                  {isRunningThis && (
                    <div className="text-xs text-blue-800 mt-1">
                      Fetching {status?.job} — page {status?.currentPage} / {status?.lastPage}
                      {' '}(job {(status?.jobsCompleted ?? 0) + 1} / {status?.jobsTotal})
                    </div>
                  )}
                  {status?.state === 'failed' && status?.source === s.name && (
                    <div className="text-xs text-red-700 mt-1">Scrape failed: {status.error}</div>
                  )}
                </div>
                {isRunningThis ? (
                  <button
                    onClick={() => cancelMutation.mutate()}
                    disabled={cancelMutation.isPending}
                    className="bg-red-700 text-white text-sm rounded-md px-3 py-1.5 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={() => fetchMutation.mutate({ source: s.name, scope: 'open' })}
                      disabled={running || fetchMutation.isPending}
                      className="bg-blue-900 text-white text-sm rounded-md px-3 py-1.5 disabled:opacity-50"
                    >
                      Fetch open
                    </button>
                    <button
                      onClick={() => fetchMutation.mutate({ source: s.name, scope: 'full' })}
                      disabled={running || fetchMutation.isPending}
                      className="border border-blue-900 text-blue-900 text-sm rounded-md px-3 py-1.5 disabled:opacity-50"
                    >
                      Full refresh
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Add the navbar link and route**

In `frontend/src/App.tsx`, add the import:

```tsx
import SettingsPage from './pages/SettingsPage';
```

Change the `<nav>` block from:

```tsx
          <nav className="w-56 shrink-0 bg-white border-r border-[#e0e0e0] p-4 space-y-1 overflow-y-auto">
            <div className="text-hero font-semibold text-blue-900 mb-4">Malaysia Tender Aggregator</div>
            <NavLink to="/open" className={navLinkClass}>Open Tenders</NavLink>
            <NavLink to="/closed" className={navLinkClass}>Closed Tenders</NavLink>
            <NavLink to="/awarded" className={navLinkClass}>Awarded Tenders</NavLink>
          </nav>
```

to:

```tsx
          <nav className="w-56 shrink-0 bg-white border-r border-[#e0e0e0] p-4 flex flex-col overflow-y-auto">
            <div className="text-hero font-semibold text-blue-900 mb-4">Malaysia Tender Aggregator</div>
            <div className="space-y-1">
              <NavLink to="/open" className={navLinkClass}>Open Tenders</NavLink>
              <NavLink to="/closed" className={navLinkClass}>Closed Tenders</NavLink>
              <NavLink to="/awarded" className={navLinkClass}>Awarded Tenders</NavLink>
            </div>
            <div className="mt-auto">
              <NavLink to="/settings" className={navLinkClass}>Settings</NavLink>
            </div>
          </nav>
```

And add the route, inside `<Routes>`, alongside the others:

```tsx
                <Route path="/settings" element={<SettingsPage />} />
```

(`<ScrapeBanner />` in the header stays exactly as-is for this task — Task 9 removes it.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w frontend -- SettingsPage App`
Expected: PASS (all new tests in both files, and every pre-existing test in `App.test.tsx`).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/SettingsPage.tsx frontend/src/test/SettingsPage.test.tsx frontend/src/App.tsx frontend/src/test/App.test.tsx
git commit -m "feat(frontend): add Settings page with per-source fetch/cancel controls"
```

---

### Task 9: Remove the header Rescrape button and `ScrapeBanner`

**Files:**
- Delete: `frontend/src/components/ScrapeBanner.tsx`
- Delete: `frontend/src/test/ScrapeBanner.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: nothing (this task only removes code).
- Produces: nothing new — `SettingsPage` (Task 8) is now the only place scrape state and
  controls are shown.

- [ ] **Step 1: Confirm there are no other references**

Before deleting, confirm `ScrapeBanner` is only imported from `App.tsx` (it was, as of
Task 8 — this step is just a sanity check since deleting a file that's still imported
elsewhere would break the build):

Run: `grep -rn "ScrapeBanner" frontend/src --include=*.tsx --include=*.ts`
Expected: only `frontend/src/App.tsx` and `frontend/src/components/ScrapeBanner.tsx` /
`frontend/src/test/ScrapeBanner.test.tsx` themselves.

- [ ] **Step 2: Remove the import and usage from `App.tsx`**

In `frontend/src/App.tsx`, remove the line:

```tsx
import ScrapeBanner from './components/ScrapeBanner';
```

And change:

```tsx
            <header className="bg-blue-900 text-white px-6 py-4 flex items-center justify-end shrink-0">
              <ScrapeBanner />
            </header>
```

to:

```tsx
            <header className="bg-blue-900 text-white px-6 py-4 flex items-center justify-end shrink-0" />
```

- [ ] **Step 3: Delete the component and its test**

Delete `frontend/src/components/ScrapeBanner.tsx` and `frontend/src/test/ScrapeBanner.test.tsx`.

- [ ] **Step 4: Run the full frontend suite**

Run: `npm test -w frontend`
Expected: PASS (`ScrapeBanner.test.tsx` is gone, so its tests no longer run; every other
test, including the App/SettingsPage tests from Task 8, still passes).

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src/App.tsx frontend/src/components/ScrapeBanner.tsx frontend/src/test/ScrapeBanner.test.tsx
git commit -m "refactor(frontend): remove header Rescrape button, superseded by Settings page"
```

---

## Final verification

- [ ] Run the entire suite once more from the repo root: `npm test`
Expected: PASS across `shared`, `backend`, and `frontend` workspaces.
