# Daily MyProcurement Keputusan Scraping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scrape MyProcurement's fresh "Keputusan" (results) feed daily instead of relying solely on the stale Arkib archive, and remove the now-redundant on-demand "Refresh awarded results" capability for MyProcurement.

**Architecture:** Two new job entries in `MYPROCUREMENT_JOBS` target the Keputusan feed (`type=results&category=quotation`/`tender`) via the same `/procurements/fetch` endpoint and the same `parseResultsHtml` parser already used for Arkib results — no new parsing code. A new `kind: 'daily-results'` tag makes these jobs run on every `open`-scope scrape (which already happens daily via the 12:01pm cron and on every manual "Rescrape" click) and never get skipped by the backfill-completeness tracking. `MyProcurementAdapter.resultsJobNames()` changes to return `[]`, and the frontend stops showing MyProcurement's "Refresh awarded results" button.

**Tech Stack:** TypeScript (backend), React + Vite + Tailwind (frontend), Vitest.

## Global Constraints

- Write the failing test first, confirm it fails for the right reason, then write minimal code to pass it (`CLAUDE.md` TDD rule).
- Commit immediately after each green test run. Never commit red.
- Tests must never hit the real `myprocurement.treasury.gov.my` — use the existing `pageResponse`/`cardHtml` fixtures in `backend/test/adapter.test.ts`, unchanged.
- Follow the existing code style in each file exactly.

---

### Task 1: Add Keputusan jobs to `MyProcurementAdapter`

**Files:**
- Modify: `backend/src/scrapers/myprocurement/adapter.ts`
- Test: `backend/test/adapter.test.ts`

**Interfaces:**
- Consumes: `parseResultsHtml` (`backend/src/scrapers/myprocurement/parseResults.ts`, unchanged — takes `{ procurementType: 'quotation' | 'tender' }`).
- Produces: no new exports; `MyProcurementAdapter.resultsJobNames()` changes its return value (was the 2 Arkib results job names, now `[]`) — Task 2's frontend change depends on this but not on any new export.

This task rewrites `backend/test/adapter.test.ts` and `backend/src/scrapers/myprocurement/adapter.ts` together, in one TDD cycle (the two files' existing tests and implementation are tightly coupled — every existing test asserts on exact job counts/names that the new jobs shift).

- [ ] **Step 1: Replace the test file with the updated version**

Replace the full contents of `backend/test/adapter.test.ts` with:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { TenderPatch } from '@tms/shared';
import { MyProcurementAdapter, MYPROCUREMENT_JOBS } from '../src/scrapers/myprocurement/adapter.js';

// Minimal parseable card generator (same markup shape both parsers understand: identity +
// reference number + title link; no winner table, so results jobs yield winners: []).
function cardHtml(id: number, ref: string): string {
  return `<div x-data="{ selected: false, open: true }">
    <button x-on:click="$dispatch('select-procurement', { id: ${id} })"></button>
    <div class="px-4 py-2"><span class="font-bold">No. Sebut Harga</span>: ${ref}</div>
    <div class="font-bold text-primary"><a href="https://myprocurement.treasury.gov.my/advertisements/quotation/h${id}">TITLE ${id}</a></div>
  </div>`;
}

function pageResponse(ids: number[], lastPage: number) {
  return { html: `<div>${ids.map((i) => cardHtml(i, `REF/${i}`)).join('')}</div>`, total: ids.length, page: 1, lastPage };
}

describe('MYPROCUREMENT_JOBS', () => {
  it('defines exactly the 10 verified type/category combinations (6 full + 2 archive-results + 2 Keputusan)', () => {
    expect(MYPROCUREMENT_JOBS).toEqual([
      { status: 'open', procurementType: 'quotation', type: 'advertisements', category: 'quotation', kind: 'full' },
      { status: 'open', procurementType: 'tender', type: 'advertisements', category: 'tender', kind: 'full' },
      { status: 'open', procurementType: 'requisition', type: 'advertisements', category: 'requisition', kind: 'full' },
      { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'advertisement-quotation', kind: 'full' },
      { status: 'closed', procurementType: 'tender', type: 'archive', category: 'advertisement-tender', kind: 'full' },
      { status: 'closed', procurementType: 'requisition', type: 'archive', category: 'advertisement-requisition', kind: 'full' },
      { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'results-quotation', kind: 'results' },
      { status: 'closed', procurementType: 'tender', type: 'archive', category: 'results-tender', kind: 'results' },
      { status: 'closed', procurementType: 'quotation', type: 'results', category: 'quotation', kind: 'daily-results' },
      { status: 'closed', procurementType: 'tender', type: 'results', category: 'tender', kind: 'daily-results' },
    ]);
  });
});

describe('MyProcurementAdapter', () => {
  it('scope=open crawls the 3 advertisement jobs plus the 2 Keputusan jobs (5 total), every page, with explicit params', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      return pageResponse([page * 10 + 1], 2); // 2 pages per job
    });
    const adapter = new MyProcurementAdapter(fetcher);
    const batches: TenderPatch[][] = [];
    await adapter.scrape('open', { onProgress: () => {}, onBatch: async (t) => { batches.push(t); } });

    expect(urls).toHaveLength(10); // 5 jobs x 2 pages
    const advertisementUrls = urls.filter((u) => new URL(u).searchParams.get('type') === 'advertisements');
    const keputusanUrls = urls.filter((u) => new URL(u).searchParams.get('type') === 'results');
    expect(advertisementUrls).toHaveLength(6); // 3 jobs x 2 pages
    expect(keputusanUrls).toHaveLength(4); // 2 jobs x 2 pages
    for (const url of advertisementUrls) {
      expect(['quotation', 'tender', 'requisition']).toContain(new URL(url).searchParams.get('category'));
    }
    for (const url of keputusanUrls) {
      expect(['quotation', 'tender']).toContain(new URL(url).searchParams.get('category'));
    }
    for (const url of urls) expect(new URL(url).searchParams.get('itemsPerPage')).toBe('100');
    expect(batches).toHaveLength(10);
    expect(batches.flat().filter((t) => t.status === 'open')).toHaveLength(6);
    expect(batches.flat().filter((t) => t.status === 'closed')).toHaveLength(4);
  });

  it('scope=archive crawls the 3 archive jobs plus the 4 results jobs (2 archive-results + 2 Keputusan) — 7 total', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { urls.push(url); return pageResponse([1], 1); });
    const adapter = new MyProcurementAdapter(fetcher);
    await adapter.scrape('archive', { onProgress: () => {}, onBatch: async () => {} });
    expect(urls).toHaveLength(7);
    const archiveUrls = urls.filter((u) => new URL(u).searchParams.get('type') === 'archive');
    const keputusanUrls = urls.filter((u) => new URL(u).searchParams.get('type') === 'results');
    expect(archiveUrls).toHaveLength(5);
    expect(keputusanUrls).toHaveLength(2);
    for (const url of archiveUrls) {
      expect(new URL(url).searchParams.get('category')).toMatch(/^(advertisement-(quotation|tender|requisition)|results-(quotation|tender))$/);
    }
    for (const url of keputusanUrls) {
      expect(['quotation', 'tender']).toContain(new URL(url).searchParams.get('category'));
    }
  });

  it('scope=all runs all 10 jobs and tags status/procurementType per job', async () => {
    const fetcher = vi.fn(async (url: string) => pageResponse([Number(new URL(url).searchParams.get('page'))], 1));
    const adapter = new MyProcurementAdapter(fetcher);
    const all: TenderPatch[] = [];
    await adapter.scrape('all', { onProgress: () => {}, onBatch: async (t) => { all.push(...t); } });
    expect(all.filter((t) => t.status === 'open')).toHaveLength(3);
    expect(all.filter((t) => t.status === 'closed')).toHaveLength(7);
  });

  it('emits winners (possibly empty) only for results-kind jobs (archive + Keputusan), via parseResultsHtml', async () => {
    const fetcher = vi.fn(async () => pageResponse([1], 1));
    const adapter = new MyProcurementAdapter(fetcher);
    const batchesByJob: TenderPatch[][] = [];
    await adapter.scrape('archive', { onProgress: () => {}, onBatch: async (t) => { batchesByJob.push(t); } });
    // Jobs run in MYPROCUREMENT_JOBS order filtered to closed: 3 full archive jobs, then 2 archive-results jobs, then 2 Keputusan jobs.
    const resultsBatches = batchesByJob.slice(3);
    expect(resultsBatches).toHaveLength(4);
    for (const batch of resultsBatches) {
      for (const patch of batch) {
        expect(patch.winners).toEqual([]); // no winner table in this fixture's card markup
        expect(patch.fieldCodes).toBeUndefined(); // results patches never observe field codes
      }
    }
  });

  it('reports progress with job name, page counts and job totals', async () => {
    const fetcher = vi.fn(async () => pageResponse([1], 2));
    const adapter = new MyProcurementAdapter(fetcher);
    const progress: unknown[] = [];
    await adapter.scrape('archive', { onProgress: (p) => progress.push({ ...p }), onBatch: async () => {} });
    expect(progress[0]).toEqual({
      source: 'myprocurement', job: 'closed-quotation',
      jobsCompleted: 0, jobsTotal: 7, currentPage: 1, lastPage: 2,
    });
  });

  it('names results and Keputusan jobs distinctly (job name pattern)', async () => {
    const fetcher = vi.fn(async () => pageResponse([1], 1));
    const adapter = new MyProcurementAdapter(fetcher);
    const jobNames: string[] = [];
    await adapter.scrape('archive', { onProgress: (p) => jobNames.push(p.job), onBatch: async () => {} });
    expect(jobNames).toEqual([
      'closed-quotation', 'closed-tender', 'closed-requisition',
      'closed-quotation-results', 'closed-tender-results',
      'quotation-keputusan', 'tender-keputusan',
    ]);
  });

  it('rejects when the fetcher exhausts retries, without calling onBatch for the failed page', async () => {
    const fetcher = vi.fn(async () => { throw new Error('fetch failed after 3 attempts: x'); });
    const adapter = new MyProcurementAdapter(fetcher);
    const onBatch = vi.fn(async () => {});
    await expect(adapter.scrape('open', { onProgress: () => {}, onBatch })).rejects.toThrow('fetch failed');
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('archiveJobNames() lists the 5 closed job names (the set backfill-completeness is tracked against) and excludes the always-rerun Keputusan jobs', () => {
    const adapter = new MyProcurementAdapter(vi.fn());
    const names = adapter.archiveJobNames();
    expect(names).toEqual([
      'closed-quotation', 'closed-tender', 'closed-requisition',
      'closed-quotation-results', 'closed-tender-results',
    ]);
    expect(names).not.toContain('quotation-keputusan');
    expect(names).not.toContain('tender-keputusan');
  });

  it('resultsJobNames() returns [] — no on-demand results refresh for MyProcurement now that Keputusan runs daily', () => {
    const adapter = new MyProcurementAdapter(vi.fn());
    expect(adapter.resultsJobNames()).toEqual([]);
  });

  it('calls onJobDone with each job name once it finishes paginating, before moving to the next job', async () => {
    const fetcher = vi.fn(async () => pageResponse([1], 2));
    const adapter = new MyProcurementAdapter(fetcher);
    const done: string[] = [];
    await adapter.scrape('archive', {
      onProgress: () => {},
      onBatch: async () => {},
      onJobDone: (jobName) => { done.push(jobName); },
    });
    expect(done).toEqual([
      'closed-quotation', 'closed-tender', 'closed-requisition',
      'closed-quotation-results', 'closed-tender-results',
      'quotation-keputusan', 'tender-keputusan',
    ]);
  });

  it('skips closed jobs already present in skipJobNames, but never skips open jobs or Keputusan jobs', async () => {
    const fetcher = vi.fn(async () => pageResponse([1], 1));
    const adapter = new MyProcurementAdapter(fetcher);
    const jobNames: string[] = [];
    await adapter.scrape('all', { onProgress: (p) => jobNames.push(p.job), onBatch: async () => {} }, {
      skipJobNames: new Set(['closed-quotation', 'closed-quotation-results', 'quotation-keputusan', 'tender-keputusan']),
    });
    expect(jobNames).toEqual([
      'open-quotation', 'open-tender', 'open-requisition',
      'closed-tender', 'closed-requisition', 'closed-tender-results',
      'quotation-keputusan', 'tender-keputusan',
    ]);
  });

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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w backend -- adapter.test`
Expected: FAIL — the `MYPROCUREMENT_JOBS` equality test fails (only 8 entries exist, not 10), and most `scope=` tests fail on job/URL counts, since the implementation hasn't changed yet.

- [ ] **Step 3: Update the implementation**

Replace the full contents of `backend/src/scrapers/myprocurement/adapter.ts` with:

```ts
import { z } from 'zod';
import type { ScrapeHooks, ScrapeOptions, ScrapeScope, ScraperAdapter } from '../types.js';
import { parseListingHtml } from './parseListing.js';
import { parseResultsHtml } from './parseResults.js';

const BASE_URL = 'https://myprocurement.treasury.gov.my/procurements/fetch';
const ITEMS_PER_PAGE = 100;

export const MYPROCUREMENT_JOBS = [
  { status: 'open', procurementType: 'quotation', type: 'advertisements', category: 'quotation', kind: 'full' },
  { status: 'open', procurementType: 'tender', type: 'advertisements', category: 'tender', kind: 'full' },
  { status: 'open', procurementType: 'requisition', type: 'advertisements', category: 'requisition', kind: 'full' },
  { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'advertisement-quotation', kind: 'full' },
  { status: 'closed', procurementType: 'tender', type: 'archive', category: 'advertisement-tender', kind: 'full' },
  { status: 'closed', procurementType: 'requisition', type: 'archive', category: 'advertisement-requisition', kind: 'full' },
  { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'results-quotation', kind: 'results' },
  { status: 'closed', procurementType: 'tender', type: 'archive', category: 'results-tender', kind: 'results' },
  { status: 'closed', procurementType: 'quotation', type: 'results', category: 'quotation', kind: 'daily-results' },
  { status: 'closed', procurementType: 'tender', type: 'results', category: 'tender', kind: 'daily-results' },
] as const;

const ListingResponse = z.object({ html: z.string(), lastPage: z.number().int().min(1) });

type MyProcurementJob = (typeof MYPROCUREMENT_JOBS)[number];

function jobName(job: MyProcurementJob): string {
  if (job.kind === 'results') return `${job.status}-${job.procurementType}-results`;
  if (job.kind === 'daily-results') return `${job.procurementType}-keputusan`;
  return `${job.status}-${job.procurementType}`;
}

export class MyProcurementAdapter implements ScraperAdapter {
  readonly name = 'myprocurement';

  constructor(private readonly fetcher: (url: string) => Promise<unknown>) {}

  archiveJobNames(): string[] {
    return MYPROCUREMENT_JOBS.filter((j) => j.status === 'closed' && j.kind !== 'daily-results').map(jobName);
  }

  resultsJobNames(): string[] {
    return [];
  }

  async scrape(scope: ScrapeScope, hooks: ScrapeHooks, opts: ScrapeOptions = {}): Promise<void> {
    const jobs = MYPROCUREMENT_JOBS.filter((j) => {
      const inScope = scope === 'all' ? true
        : scope === 'open' ? (j.status === 'open' || j.kind === 'daily-results')
        : j.status === 'closed';
      if (!inScope) return false;
      if (j.status === 'closed' && j.kind !== 'daily-results' && opts.skipJobNames?.has(jobName(j))) return false; // already backfilled
      return true;
    });

    for (const [jobIndex, job] of jobs.entries()) {
      if (opts.isCancelled?.()) return;
      const name = jobName(job);
      let page = 1;
      let lastPage = 1;
      do {
        if (opts.isCancelled?.()) return;
        const url = `${BASE_URL}?page=${page}&itemsPerPage=${ITEMS_PER_PAGE}&type=${job.type}&category=${job.category}`;
        const body = ListingResponse.parse(await this.fetcher(url));
        lastPage = body.lastPage;
        hooks.onProgress({
          source: this.name,
          job: name,
          jobsCompleted: jobIndex,
          jobsTotal: jobs.length,
          currentPage: page,
          lastPage,
        });
        const patches = job.kind === 'results' || job.kind === 'daily-results'
          ? parseResultsHtml(body.html, { procurementType: job.procurementType })
          : parseListingHtml(body.html, { status: job.status, procurementType: job.procurementType });
        await hooks.onBatch(patches);
        page += 1;
      } while (page <= lastPage);
      await hooks.onJobDone?.(name);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w backend -- adapter.test`
Expected: PASS (13 tests)

- [ ] **Step 5: Run the full backend suite**

Run: `npm run test -w backend`
Expected: PASS — `startupPolicy.test.ts` and `manager.test.ts` are unaffected (they exercise `archiveJobNames()`/`resultsJobNames()` via fake adapters, not `MyProcurementAdapter` directly), but run the full suite to confirm no ripple effects (e.g. any snapshot of `MYPROCUREMENT_JOBS` elsewhere).

- [ ] **Step 6: Commit**

```bash
git add backend/src/scrapers/myprocurement/adapter.ts backend/test/adapter.test.ts
git commit -m "feat: scrape MyProcurement Keputusan feed daily instead of relying on stale Arkib"
```

---

### Task 2: Remove MyProcurement's on-demand results-refresh button

**Files:**
- Modify: `frontend/src/pages/SettingsPage.tsx`
- Test: `frontend/src/test/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: nothing new — `SOURCES_WITH_RESULTS_REFRESH` is a frontend-only hardcoded set (already documented at its definition as intentionally not derived from `resultsJobNames()`), and Task 1 already made `MyProcurementAdapter.resultsJobNames()` return `[]`, which independently makes `POST /api/scrape` with `{ source: 'myprocurement', scope: 'results' }` return 409 if it were ever sent (belt-and-braces; this task's frontend change stops it from being sent in the first place).
- Produces: nothing consumed by later tasks — this is the last task.

- [ ] **Step 1: Update the failing tests**

In `frontend/src/test/SettingsPage.test.tsx`, replace these four tests:

Replace:
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
```
with:
```ts
  it('shows a Refresh awarded results button for kwsp, not for myprocurement or span', async () => {
    renderSettings();
    const kwspRow = await screen.findByRole('group', { name: 'kwsp' });
    expect(within(kwspRow).getByRole('button', { name: /refresh awarded results/i })).toBeInTheDocument();
    const mpRow = screen.getByRole('group', { name: 'myprocurement' });
    expect(within(mpRow).queryByRole('button', { name: /refresh awarded results/i })).not.toBeInTheDocument();
    const spanRow = screen.getByRole('group', { name: 'span' });
    expect(within(spanRow).queryByRole('button', { name: /refresh awarded results/i })).not.toBeInTheDocument();
  });
```

Replace:
```ts
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
```
with:
```ts
  it("clicking Refresh awarded results sends that row's source with scope=results", async () => {
    let seenBody: unknown;
    server.use(http.post('/api/scrape', async ({ request }) => {
      seenBody = await request.json();
      return HttpResponse.json({ started: true }, { status: 202 });
    }));
    renderSettings();
    const kwspRow = await screen.findByRole('group', { name: 'kwsp' });
    await userEvent.click(within(kwspRow).getByRole('button', { name: /refresh awarded results/i }));
    await waitFor(() => expect(seenBody).toEqual({ source: 'kwsp', scope: 'results' }));
  });
```

Replace:
```ts
  it('disables Refresh awarded results while any row is running', async () => {
    server.use(http.get('/api/scrape/status', () => HttpResponse.json({
      state: 'running', source: 'span', job: 'open-2026', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1,
    })));
    renderSettings();
    const mpRow = await screen.findByRole('group', { name: 'myprocurement' });
    expect(within(mpRow).getByRole('button', { name: /refresh awarded results/i })).toBeDisabled();
  });
```
with:
```ts
  it('disables Refresh awarded results while any row is running', async () => {
    server.use(http.get('/api/scrape/status', () => HttpResponse.json({
      state: 'running', source: 'span', job: 'open-2026', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1,
    })));
    renderSettings();
    const kwspRow = await screen.findByRole('group', { name: 'kwsp' });
    expect(within(kwspRow).getByRole('button', { name: /refresh awarded results/i })).toBeDisabled();
  });
```

Replace:
```ts
  it('hides every rescrape/cancel/refresh button for a member', async () => {
    renderSettingsAsMember();
    const spanRow = await screen.findByRole('group', { name: 'span' });
    expect(within(spanRow).queryByRole('button', { name: /fetch open/i })).not.toBeInTheDocument();
    expect(within(spanRow).queryByRole('button', { name: /full refresh/i })).not.toBeInTheDocument();
    const mpRow = screen.getByRole('group', { name: 'myprocurement' });
    expect(within(mpRow).queryByRole('button', { name: /refresh awarded results/i })).not.toBeInTheDocument();
  });
```
with:
```ts
  it('hides every rescrape/cancel/refresh button for a member', async () => {
    renderSettingsAsMember();
    const spanRow = await screen.findByRole('group', { name: 'span' });
    expect(within(spanRow).queryByRole('button', { name: /fetch open/i })).not.toBeInTheDocument();
    expect(within(spanRow).queryByRole('button', { name: /full refresh/i })).not.toBeInTheDocument();
    const kwspRow = screen.getByRole('group', { name: 'kwsp' });
    expect(within(kwspRow).queryByRole('button', { name: /refresh awarded results/i })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w frontend -- SettingsPage`
Expected: FAIL — the updated tests targeting `kwspRow`/expecting `mpRow` to lack the button fail, since `SOURCES_WITH_RESULTS_REFRESH` still contains `'myprocurement'`.

- [ ] **Step 3: Update the implementation**

In `frontend/src/pages/SettingsPage.tsx`, change:

```ts
const SOURCES_WITH_RESULTS_REFRESH = new Set(['myprocurement', 'kwsp', 'llm']);
```
to:
```ts
const SOURCES_WITH_RESULTS_REFRESH = new Set(['kwsp', 'llm']);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w frontend -- SettingsPage`
Expected: PASS

- [ ] **Step 5: Run the full frontend suite**

Run: `npm run test -w frontend`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/SettingsPage.tsx frontend/src/test/SettingsPage.test.tsx
git commit -m "feat: remove MyProcurement's on-demand results-refresh button (superseded by daily Keputusan scraping)"
```

---

### Task 3: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all workspaces pass (shared, backend, frontend), coverage thresholds met.

- [ ] **Step 2: Manually verify in the browser**

Start the dev servers, go to Settings, confirm:
- MyProcurement's row no longer shows a "Refresh awarded results" button.
- KWSP's row still shows it.
- Clicking "Fetch open" or "Full refresh" for MyProcurement still works (these now implicitly include the 2 new Keputusan jobs — check the in-progress job name cycles through `quotation-keputusan`/`tender-keputusan` alongside the existing job names).
