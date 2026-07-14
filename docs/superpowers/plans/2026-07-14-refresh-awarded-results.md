# Refresh Awarded Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-demand "Refresh awarded results" action per data source, so newly-awarded tenders (winners published after a source's initial archive backfill) can be picked up without hand-editing `meta.json` — see `docs/superpowers/specs/2026-07-14-refresh-awarded-results-design.md`.

**Architecture:** No new scraping mechanism. Adds a `resultsJobNames()` method to each scraper adapter (the subset of its archive jobs that carry winner data), a `ScrapeManager.refreshResults(sourceName)` method that clears just those job names from the source's persisted `completedArchiveJobs` and re-triggers the existing `archive`-scope scrape pipeline unchanged, a `scope: 'results'` value on `POST /api/scrape`, and a third per-source button in Settings (shown only for sources that have results jobs — MyProcurement and KWSP, not SPAN).

**Tech Stack:** TypeScript, Express, Zod, React 19, TanStack Query, Vitest + Testing Library + MSW, Supertest.

## Global Constraints

- Write the failing test FIRST for every behavior change; confirm it fails for the right reason before implementing.
- Never commit red. Run the relevant test file after each implementation step; run the full workspace suite (`npm test`) before each commit.
- Tests must NEVER hit the real `myprocurement.treasury.gov.my` (or any real scraper site) — use fake adapters / fixtures, never a real fetcher.
- Coverage thresholds (80% lines/branches) are enforced by vitest; do not lower thresholds or skip hooks (no `--no-verify`).
- Follow existing patterns exactly: adapters implement `ScraperAdapter`, the manager mediates all scrape state, Settings renders one row per source from `/api/sources`.
- No new npm dependencies.
- `resultsJobNames()` is added as an **optional** interface member (not required) so the many existing fake/mock `ScraperAdapter` object literals across other test files (`app.test.ts`, `manager.test.ts`'s own pre-existing tests) don't need touching — they simply don't implement it, and callers use `adapter.resultsJobNames?.() ?? []`.

---

### Task 1: `resultsJobNames()` on all three scraper adapters

**Files:**
- Modify: `backend/src/scrapers/types.ts`
- Modify: `backend/src/scrapers/myprocurement/adapter.ts`
- Modify: `backend/src/scrapers/kwsp/adapter.ts`
- Modify: `backend/src/scrapers/span/adapter.ts`
- Test: `backend/test/adapter.test.ts`
- Test: `backend/test/kwspAdapter.test.ts`
- Test: `backend/test/spanAdapter.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ScraperAdapter.resultsJobNames?(): string[]` — consumed by Task 2 (`ScrapeManager.refreshResults`).

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/adapter.test.ts`, in the same `describe` block as the existing `archiveJobNames()` test (near line 125):

```ts
  it('resultsJobNames() lists only the 2 job names that carry winner data', () => {
    const adapter = new MyProcurementAdapter(vi.fn());
    expect(adapter.resultsJobNames()).toEqual(['closed-quotation-results', 'closed-tender-results']);
  });
```

Add to `backend/test/kwspAdapter.test.ts`, in the `describe('KwspAdapter — job model', ...)` block (near line 40, right after the existing `archiveJobNames()` test):

```ts
  it('reports "results" as its only results job (same as its only archive job)', () => {
    const adapter = new KwspAdapter(vi.fn());
    expect(adapter.resultsJobNames()).toEqual(['results']);
  });
```

Add to `backend/test/spanAdapter.test.ts`, in the `describe('SpanAdapter — job model', ...)` block (near line 22, right after the existing `archiveJobNames()` test):

```ts
  it('reports no results jobs — winners are fetched inline as part of each closed-year job, not a separate job', () => {
    const adapter = new SpanAdapter(vi.fn(), FIXED_NOW);
    expect(adapter.resultsJobNames()).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- adapter.test.ts kwspAdapter.test.ts spanAdapter.test.ts`
Expected: FAIL — `adapter.resultsJobNames is not a function` (all three)

- [ ] **Step 3: Write minimal implementation**

In `backend/src/scrapers/types.ts`, add the optional method to the interface (after `archiveJobNames()`):

```ts
export interface ScraperAdapter {
  name: string;
  scrape(scope: ScrapeScope, hooks: ScrapeHooks, opts?: ScrapeOptions): Promise<void>;
  /** The full set of closed/archive job names this adapter will ever run, used to detect newly added job kinds. */
  archiveJobNames(): string[];
  /** The subset of archiveJobNames() that specifically carries award/winner data (vs. plain listing data).
   * Optional — an adapter with no separate results job (e.g. one that fetches winners inline as part of
   * its normal listing job) simply omits this; callers treat a missing implementation as []. */
  resultsJobNames?(): string[];
}
```

In `backend/src/scrapers/myprocurement/adapter.ts`, add the method right after `archiveJobNames()` (line 35):

```ts
  resultsJobNames(): string[] {
    return MYPROCUREMENT_JOBS.filter((j) => j.kind === 'results').map(jobName);
  }
```

In `backend/src/scrapers/kwsp/adapter.ts`, add the method right after `archiveJobNames()` (line 27):

```ts
  resultsJobNames(): string[] {
    return this.archiveJobNames();
  }
```

In `backend/src/scrapers/span/adapter.ts`, add the method right after `archiveJobNames()` (line 42):

```ts
  resultsJobNames(): string[] {
    return []; // winners are fetched inline as part of each closed-year job, not a separate job
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend -- adapter.test.ts kwspAdapter.test.ts spanAdapter.test.ts`
Expected: PASS (all three new tests, plus every pre-existing test in these files still passing)

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrapers/types.ts backend/src/scrapers/myprocurement/adapter.ts backend/src/scrapers/kwsp/adapter.ts backend/src/scrapers/span/adapter.ts backend/test/adapter.test.ts backend/test/kwspAdapter.test.ts backend/test/spanAdapter.test.ts
git commit -m "feat: add resultsJobNames() to identify which archive jobs carry winner data"
```

---

### Task 2: `ScrapeManager.refreshResults()`

**Files:**
- Modify: `backend/src/scrape/manager.ts`
- Test: `backend/test/manager.test.ts`

**Interfaces:**
- Consumes: `ScraperAdapter.resultsJobNames?()` (Task 1).
- Produces: `ScrapeManager.refreshResults(sourceName: string): boolean` — consumed by Task 3 (`POST /api/scrape` route).

- [ ] **Step 1: Write the failing tests**

In `backend/test/manager.test.ts`, extend the `fakeAdapter` helper (near line 21) to accept an optional third parameter, `resultsJobNames`, matching the existing `archiveJobNames` parameter:

```ts
function fakeAdapter(
  behavior: (scope: ScrapeScope, hooks: ScrapeHooks, opts?: import('../src/scrapers/types.js').ScrapeOptions) => Promise<void>,
  archiveJobNames: string[] = [],
  resultsJobNames: string[] = [],
): ScraperAdapter {
  return { name: 'fake', scrape: behavior, archiveJobNames: () => archiveJobNames, resultsJobNames: () => resultsJobNames };
}
```

(This is a backward-compatible addition — every existing call to `fakeAdapter(...)` with one or two arguments keeps working unchanged, `resultsJobNames` just defaults to `[]`.)

Add these tests to the `describe('ScrapeManager', ...)` block, after the existing `'passes previously-completed archive job names as skipJobNames...'` test (near line 150):

```ts
  it('refreshResults clears only that source\'s results job names, re-runs an archive scrape, and leaves other completed jobs untouched', async () => {
    const repo = await freshRepo();
    await repo.setMeta('fake', {
      completedArchiveJobs: ['closed-quotation', 'closed-quotation-results', 'closed-tender-results'],
    });
    const seenScopes: ScrapeScope[] = [];
    let seenSkip: Set<string> | undefined;
    const adapter = fakeAdapter(
      async (scope, _hooks, opts) => { seenScopes.push(scope); seenSkip = opts?.skipJobNames; },
      [],
      ['closed-quotation-results', 'closed-tender-results'],
    );
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    expect(mgr.refreshResults('fake')).toBe(true);
    await waitUntil(() => mgr.status().state === 'done');
    expect(seenScopes).toEqual(['archive']);
    // the two results jobs are no longer in skipJobNames (so the adapter will re-run them), but
    // the untouched advertisement job is still there
    expect(seenSkip).toEqual(new Set(['closed-quotation']));
    // the fake adapter never calls onJobDone, so the persisted completedArchiveJobs reflects
    // exactly what refreshResults left behind — proof it only removed the two results entries
    expect(repo.getMeta('fake').completedArchiveJobs).toEqual(['closed-quotation']);
  });

  it('refreshResults returns false when a scrape is already running, without touching completedArchiveJobs', async () => {
    const repo = await freshRepo();
    await repo.setMeta('fake', { completedArchiveJobs: ['closed-quotation-results'] });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const adapter = fakeAdapter(async () => gate, [], ['closed-quotation-results']);
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    mgr.start('open');
    await waitUntil(() => mgr.status().state === 'running');
    expect(mgr.refreshResults('fake')).toBe(false);
    expect(repo.getMeta('fake').completedArchiveJobs).toEqual(['closed-quotation-results']);
    release();
    await waitUntil(() => mgr.status().state !== 'running');
  });

  it('refreshResults returns false for a source name that matches no adapter', async () => {
    const repo = await freshRepo();
    const mgr = new ScrapeManager([], repo, { now: NOW });
    expect(mgr.refreshResults('nope')).toBe(false);
  });

  it('refreshResults returns false when the adapter has no results jobs to refresh', async () => {
    const repo = await freshRepo();
    const adapter = fakeAdapter(async () => {}, [], []); // no results jobs, e.g. SPAN
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    expect(mgr.refreshResults('fake')).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- manager.test.ts`
Expected: FAIL — `mgr.refreshResults is not a function` (all four new tests)

- [ ] **Step 3: Write minimal implementation**

In `backend/src/scrape/manager.ts`, add the method right after `start()` (line 62):

```ts
  /**
   * Clears just the given source's *results* job names (per its adapter's resultsJobNames())
   * from its persisted completedArchiveJobs, then re-runs an archive-scope scrape for that
   * source — the existing skip-already-completed-job logic in each adapter's scrape() then
   * naturally re-runs only those jobs, leaving already-complete advertisement/listing jobs
   * alone. Returns false (same convention as start()) when a scrape is already running, the
   * source name matches no registered adapter, or the adapter has no results jobs at all.
   *
   * repo.setMeta() is called without awaiting its returned promise: its in-memory map update
   * happens synchronously (before setMeta's first `await`), so by the time start() is called
   * on the next line — in the same synchronous tick — the trimmed completedArchiveJobs is
   * already visible to runToCompletion()'s own read of it. This also means start()'s own
   * synchronous `this.running = true` guard fires in that same tick, so there is no window
   * where a concurrent start()/refreshResults() call could race past the "already running"
   * check. (Chaining via `.then()` instead would leave exactly that race open, since the
   * disk-write portion of setMeta is real async I/O.)
   */
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend -- manager.test.ts`
Expected: PASS (all four new tests, plus every pre-existing test in this file still passing)

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrape/manager.ts backend/test/manager.test.ts
git commit -m "feat: add ScrapeManager.refreshResults() to re-run just a source's results jobs"
```

---

### Task 3: `POST /api/scrape` accepts `scope: 'results'`

**Files:**
- Modify: `backend/src/api/app.ts`
- Test: `backend/test/app.test.ts`

**Interfaces:**
- Consumes: `ScrapeManager.refreshResults(sourceName)` (Task 2).
- Produces: `POST /api/scrape` accepting `{ source: string, scope: 'results' }` — consumed by Task 4 (frontend).

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/app.test.ts`, after the existing `'POST /api/scrape rejects an invalid scope value with 400'` test (near line 205):

```ts
  it('POST /api/scrape with scope=results refreshes only that source\'s results jobs (202), and 409s when the adapter has none', async () => {
    await repo.setMeta('myprocurement', { completedArchiveJobs: ['closed-quotation', 'closed-quotation-results'] });
    const scrapedScopes: string[] = [];
    const adapter = {
      name: 'myprocurement',
      scrape: async (scope: string) => { scrapedScopes.push(scope); },
      archiveJobNames: () => ['closed-quotation', 'closed-quotation-results'],
      resultsJobNames: () => ['closed-quotation-results'],
    };
    const mgr = new ScrapeManager([adapter], repo);
    const app2 = createApp({ repo, manager: mgr });

    const res = await request(app2).post('/api/scrape').send({ source: 'myprocurement', scope: 'results' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ started: true });
    await waitUntilNotRunning(app2);
    expect(scrapedScopes).toEqual(['archive']);
    expect(repo.getMeta('myprocurement').completedArchiveJobs).toEqual(['closed-quotation']);

    const noResultsAdapter = { name: 'span', scrape: async () => {}, archiveJobNames: () => [], resultsJobNames: () => [] };
    const mgr2 = new ScrapeManager([noResultsAdapter], repo);
    const app3 = createApp({ repo, manager: mgr2 });
    const res2 = await request(app3).post('/api/scrape').send({ source: 'span', scope: 'results' });
    expect(res2.status).toBe(409);
  });

  it('POST /api/scrape with scope=results and no source returns 400', async () => {
    const res = await request(app).post('/api/scrape').send({ scope: 'results' });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- app.test.ts`
Expected: FAIL on the first new test's `expect(res.status).toBe(202)` assertion — it receives `400` instead, because `'results'` isn't yet in `ScrapeRequestSchema`'s `scope` enum, so `safeParse` rejects the whole request before ever reaching the new branch. (The second new test also currently gets `400`, but that's a false positive at this stage — it's the same schema-rejection path, not yet the dedicated `source is required` check Step 3 adds. Step 4 re-running after Step 3 is what confirms the right code path produced it.)

- [ ] **Step 3: Write minimal implementation**

In `backend/src/api/app.ts`, change the schema (line 9-12):

```ts
const ScrapeRequestSchema = z.object({
  source: z.string().optional(),
  scope: z.enum(['open', 'full', 'results']).optional(),
});
```

And update the route handler (line 64-71):

```ts
  app.post('/api/scrape', (req, res) => {
    const parsed = ScrapeRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    if (parsed.data.scope === 'results') {
      if (!parsed.data.source) return res.status(400).json({ error: 'source is required for scope=results' });
      const started = deps.manager.refreshResults(parsed.data.source);
      if (!started) return res.status(409).json({ error: 'cannot refresh results for this source' });
      return res.status(202).json({ started: true });
    }
    const scope = parsed.data.scope === 'full' ? 'all' : 'open';
    const started = deps.manager.start(scope, { sourceName: parsed.data.source });
    if (!started) return res.status(409).json({ error: 'scrape already running' });
    res.status(202).json({ started: true });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend -- app.test.ts`
Expected: PASS (both new tests, plus every pre-existing test in this file still passing)

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/app.ts backend/test/app.test.ts
git commit -m "feat: accept scope=results on POST /api/scrape"
```

---

### Task 4: "Refresh awarded results" button in Settings

**Files:**
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/pages/SettingsPage.tsx`
- Modify: `frontend/src/test/mocks.ts`
- Test: `frontend/src/test/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: `POST /api/scrape` with `scope: 'results'` (Task 3).
- Produces: nothing (leaf task).

- [ ] **Step 1: Write the failing tests**

In `frontend/src/test/mocks.ts`, add a third entry to `defaultSources` (line 31-34), so there's a KWSP row to test against:

```ts
export const defaultSources: ScrapeSource[] = [
  { name: 'myprocurement', lastScrapedAt: '2026-07-07T00:00:00.000Z', lastArchiveBackfillAt: '2026-07-01T00:00:00.000Z', total: 5775 },
  { name: 'span', lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 },
  { name: 'kwsp', lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 },
];
```

Add to `frontend/src/test/SettingsPage.test.tsx`, after the existing `"clicking Full refresh sends that row's source with scope=full"` test (near line 51):

```ts
  it('shows a Refresh awarded results button for myprocurement and kwsp, not for span', async () => {
    renderSettings();
    const mpRow = await screen.findByRole('group', { name: 'myprocurement' });
    expect(within(mpRow).getByRole('button', { name: /refresh awarded results/i })).toBeInTheDocument();
    const kwspRow = screen.getByRole('group', { name: 'kwsp' });
    expect(within(kwspRow).getByRole('button', { name: /refresh awarded results/i })).toBeInTheDocument();
    const spanRow = screen.getByRole('group', { name: 'span' });
    expect(within(spanRow).queryByRole('button', { name: /refresh awarded results/i })).not.toBeInTheDocument();
  });

  it("clicking Refresh awarded results sends that row's source with scope=results", async () => {
    let seenBody: unknown;
    server.use(http.post('/api/scrape', async ({ request }) => {
      seenBody = await request.json();
      return HttpResponse.json({ started: true }, { status: 202 });
    }));
    renderSettings();
    const mpRow = await screen.findByRole('group', { name: 'myprocurement' });
    await userEvent.click(within(mpRow).getByRole('button', { name: /refresh awarded results/i }));
    await waitFor(() => expect(seenBody).toEqual({ source: 'myprocurement', scope: 'results' }));
  });

  it('disables Refresh awarded results while any row is running', async () => {
    server.use(http.get('/api/scrape/status', () => HttpResponse.json({
      state: 'running', source: 'span', job: 'open-2026', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1,
    })));
    renderSettings();
    const mpRow = await screen.findByRole('group', { name: 'myprocurement' });
    expect(within(mpRow).getByRole('button', { name: /refresh awarded results/i })).toBeDisabled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w frontend -- SettingsPage.test.tsx`
Expected: FAIL — no button named "Refresh awarded results" exists yet (all three new tests)

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/api/client.ts`, widen the `scope` type on `triggerScrape` (line 30):

```ts
export async function triggerScrape(params: { source?: string; scope?: 'open' | 'full' | 'results' } = {}): Promise<void> {
```

In `frontend/src/pages/SettingsPage.tsx`, add a module-level constant right after the imports (line 2):

```ts
// Sources whose winner/award data comes from a separate "results" job that can be refreshed
// on its own — see docs/superpowers/specs/2026-07-14-refresh-awarded-results-design.md.
// SPAN fetches winners inline as part of its normal closed-tender job, so it has no separate
// results job to target here.
const SOURCES_WITH_RESULTS_REFRESH = new Set(['myprocurement', 'kwsp']);
```

Then add the third button inside the existing `<div className="flex gap-2">` block (line 61-76), right after the "Full refresh" button:

```tsx
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
                    {SOURCES_WITH_RESULTS_REFRESH.has(s.name) && (
                      <button
                        onClick={() => fetchMutation.mutate({ source: s.name, scope: 'results' })}
                        disabled={running || fetchMutation.isPending}
                        className="border border-blue-900 text-blue-900 text-sm rounded-md px-3 py-1.5 disabled:opacity-50"
                      >
                        Refresh awarded results
                      </button>
                    )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w frontend -- SettingsPage.test.tsx`
Expected: PASS (all three new tests, plus every pre-existing test in this file still passing)

- [ ] **Step 5: Run the full frontend suite and the full monorepo suite**

Run: `npm test -w frontend`
Expected: all frontend test files pass

Run: `npm test`
Expected: all workspaces (shared, backend, frontend) pass

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/pages/SettingsPage.tsx frontend/src/test/mocks.ts frontend/src/test/SettingsPage.test.tsx
git commit -m "feat: add Refresh awarded results button for myprocurement and kwsp"
```

---

### Task 5: Live verification

Not a code task — verify live in the browser per the project's `e2e-playwright-verification` skill before considering the plan complete. Because MyProcurement's full results re-crawl is ~1,178+ pages (see the design doc's investigation findings), this verification deliberately avoids letting that run to completion — it proves the wiring works end-to-end without paying that cost.

- [ ] **Step 1:** Start the backend (`npm run dev -w backend`) and the frontend (`npm run dev -w frontend`), or use a temporary alternate port per this session's established workaround if 3001/5173 are occupied.
- [ ] **Step 2:** Navigate to `/settings` — confirm the myprocurement and kwsp rows each show three buttons ("Fetch open", "Full refresh", "Refresh awarded results"), and the span row shows only the first two.
- [ ] **Step 3 (KWSP — cheap, safe to run to completion):** Click "Refresh awarded results" on the kwsp row. Confirm the progress line appears and shows the `results` job; confirm it reaches `state: 'done'` quickly (KWSP's results job is a single page fetch, not paginated) via the Settings UI or `GET /api/scrape/status`.
- [ ] **Step 4 (MyProcurement — expensive, verify-then-cancel):** Click "Refresh awarded results" on the myprocurement row. Confirm the progress line appears showing a job name ending in `-results` (e.g. `Fetching closed-quotation-results — page 1 / 1178`), proving the correct (and only the correct) jobs were unmarked and picked up. Immediately click Cancel — confirm the row returns to idle and `GET /api/scrape/status` reports `state: 'cancelled'`. Do **not** let this run to completion during verification.
- [ ] **Step 5:** Check `read_console_messages` for errors.
- [ ] **Step 6:** Revert any temporary dev-server config changes made for verification (e.g. `vite.config.ts` proxy target), and stop any temporary backend/frontend processes started for this verification.
