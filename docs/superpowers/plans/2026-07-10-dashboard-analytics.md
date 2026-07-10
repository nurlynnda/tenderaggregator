# Dashboard Analytics Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Dashboard page showing awarded-tender analytics: total value/count, top 10
ministries by spend, top 10 contractors by win count, and awarded value per year.

**Architecture:** One new pure backend aggregation function (`buildDashboardStats`) over
the existing in-memory `Tender[]`, exposed via one new read-only endpoint
(`GET /api/dashboard`). One new frontend page fetches it and renders three "bar list"
sections plus a headline stat row, using plain CSS bars (no charting library). Reuses the
app's existing "awarded" definition (`status: 'closed'` + non-empty `winners`).

**Tech Stack:** Same as the rest of the repo — TypeScript, Zod-typed shared package,
Express backend, React + Vite + Tailwind frontend, Vitest + Testing Library + MSW for
tests.

## Global Constraints

- TDD non-negotiable: write the failing test first, confirm it fails for the right
  reason, then implement (per `CLAUDE.md`).
- Commit after every green test run. Never commit red. Pre-commit hook runs the full
  workspace suite via husky — do not skip hooks.
- 80% line/branch coverage is enforced by vitest; new code needs real test coverage, not
  just happy-path smoke tests.
- No new dependencies — charts are plain `<div>` bars sized by CSS `width`/`height`
  percentage, consistent with the rest of the app's minimal-dependency Tailwind styling.
- Money is always formatted `RM 1,234,567.89` (prefix + `en-MY` locale + 2 decimal
  places) via one shared `formatMYR` helper — this matches the existing inline formatting
  already used in `frontend/src/pages/DetailPage.tsx` and
  `frontend/src/pages/TenderListPage.tsx`. (The design spec's headline example showed no
  decimal places; this plan intentionally uses the same 2-decimal format everywhere for
  consistency with the rest of the app, rather than introducing a second money format.)
- Top 10 ministries (by total value, descending) and top 10 contractors (by win count
  descending, ties broken by total value descending) — never more than 10 entries in
  either list.
- No filters, no drill-down, no per-source or per-procurement-type breakdown — out of
  scope for this iteration (see the design spec's "Out of scope" section).
- "Awarded" means `status === 'closed'` and `winners` is a non-null, non-empty array —
  the same rule the existing Awarded Tenders tab uses. Do not invent a different
  definition.

---

### Task 1: Backend — `buildDashboardStats` aggregation function

**Files:**
- Create: `backend/src/query/dashboard.ts`
- Test: `backend/test/dashboard.test.ts`

**Interfaces:**
- Consumes: `Tender` type from `@tms/shared` (already defined; has `status`, `ministry`,
  `winners: Array<{ name: string; price: number | null }> | null`, `closingDate`,
  `advertisedDate`, both `string | null` in `YYYY-MM-DD` form).
- Produces: `MinistryStat`, `ContractorStat`, `YearStat`, `DashboardStats` types, and
  `buildDashboardStats(tenders: Tender[]): DashboardStats` — used by Task 2's endpoint and
  mirrored (as plain interfaces, not imported) by Task 4's frontend types.

- [ ] **Step 1: Write the failing tests**

```ts
// backend/test/dashboard.test.ts
import { describe, expect, it } from 'vitest';
import type { Tender } from '@tms/shared';
import { buildDashboardStats } from '../src/query/dashboard.js';

let seq = 0;
function makeTender(overrides: Partial<Tender> = {}): Tender {
  seq += 1;
  return {
    dedupKey: `REF/${seq}`, referenceNo: `REF/${seq}`, title: `TENDER ${seq}`,
    status: 'closed', procurementType: 'tender',
    ministry: 'KEMENTERIAN A', agency: null, category: null, fieldCodes: [],
    advertisedDate: '2024-03-01', closingDate: '2024-03-15', indicativePrice: null,
    currency: 'MYR', events: [],
    winners: [{ name: 'ACME SDN BHD', price: 100 }],
    raw: {}, scrapedAt: '2026-07-10T00:00:00.000Z',
    sources: [{ source: 'myprocurement', sourceId: String(seq), sourceUrl: `https://example.com/${seq}` }],
    ...overrides,
  };
}

describe('buildDashboardStats', () => {
  it('returns zeros and empty lists for no tenders', () => {
    expect(buildDashboardStats([])).toEqual({
      totalAwardedValue: 0, totalAwardedCount: 0, excludedFromValueCount: 0,
      byMinistry: [], topContractors: [], byYear: [],
    });
  });

  it('counts a single awarded tender with one priced winner', () => {
    const stats = buildDashboardStats([makeTender()]);
    expect(stats.totalAwardedValue).toBe(100);
    expect(stats.totalAwardedCount).toBe(1);
    expect(stats.excludedFromValueCount).toBe(0);
    expect(stats.byMinistry).toEqual([{ ministry: 'KEMENTERIAN A', totalValue: 100, count: 1 }]);
    expect(stats.topContractors).toEqual([{ name: 'ACME SDN BHD', wins: 1, totalValue: 100 }]);
    expect(stats.byYear).toEqual([{ year: 2024, totalValue: 100 }]);
  });

  it('splits a joint award: priced winner contributes value, unpriced winner still gets a win', () => {
    const stats = buildDashboardStats([makeTender({
      winners: [{ name: 'ACME SDN BHD', price: 100 }, { name: 'BETA ENGINEERING', price: null }],
    })]);
    expect(stats.totalAwardedValue).toBe(100); // only the priced winner counts toward money
    expect(stats.excludedFromValueCount).toBe(1); // the null-price winner
    expect(stats.byMinistry).toEqual([{ ministry: 'KEMENTERIAN A', totalValue: 100, count: 1 }]);
    const acme = stats.topContractors.find((c) => c.name === 'ACME SDN BHD');
    const beta = stats.topContractors.find((c) => c.name === 'BETA ENGINEERING');
    expect(acme).toEqual({ name: 'ACME SDN BHD', wins: 1, totalValue: 100 });
    expect(beta).toEqual({ name: 'BETA ENGINEERING', wins: 1, totalValue: 0 });
  });

  it('groups a null ministry under "Unknown"', () => {
    const stats = buildDashboardStats([makeTender({ ministry: null })]);
    expect(stats.byMinistry).toEqual([{ ministry: 'Unknown', totalValue: 100, count: 1 }]);
  });

  it('uses advertisedDate for the year bucket when closingDate is missing', () => {
    const stats = buildDashboardStats([makeTender({ closingDate: null, advertisedDate: '2022-06-01' })]);
    expect(stats.byYear).toEqual([{ year: 2022, totalValue: 100 }]);
  });

  it('still counts a tender with neither date toward totals, but omits it from byYear', () => {
    const stats = buildDashboardStats([makeTender({ closingDate: null, advertisedDate: null })]);
    expect(stats.totalAwardedCount).toBe(1);
    expect(stats.totalAwardedValue).toBe(100);
    expect(stats.byYear).toEqual([]);
  });

  it('truncates to the top 10 ministries by total value, descending', () => {
    const tenders = Array.from({ length: 12 }, (_, i) => makeTender({
      ministry: `MINISTRY ${i}`,
      winners: [{ name: `CONTRACTOR ${i}`, price: (i + 1) * 1000 }],
    }));
    const stats = buildDashboardStats(tenders);
    expect(stats.byMinistry).toHaveLength(10);
    expect(stats.byMinistry[0]).toEqual({ ministry: 'MINISTRY 11', totalValue: 12000, count: 1 });
    expect(stats.byMinistry[9]).toEqual({ ministry: 'MINISTRY 2', totalValue: 3000, count: 1 });
  });

  it('truncates to the top 10 contractors by win count, descending, ties broken by value', () => {
    const many = Array.from({ length: 9 }, (_, i) => makeTender({
      winners: [{ name: `SMALL ${i}`, price: 1 }],
    }));
    const bigWinner = Array.from({ length: 3 }, () => makeTender({
      winners: [{ name: 'BIG WINNER', price: 500 }],
    }));
    const tieA = makeTender({ winners: [{ name: 'TIE A', price: 50 }] });
    const tieB = makeTender({ winners: [{ name: 'TIE B', price: 20 }] });
    const stats = buildDashboardStats([...many, ...bigWinner, tieA, tieB]);
    expect(stats.topContractors).toHaveLength(10);
    expect(stats.topContractors[0]).toEqual({ name: 'BIG WINNER', wins: 3, totalValue: 1500 });
    // TIE A and TIE B both have 1 win; TIE A's higher value must sort first
    const tieIndexA = stats.topContractors.findIndex((c) => c.name === 'TIE A');
    const tieIndexB = stats.topContractors.findIndex((c) => c.name === 'TIE B');
    expect(tieIndexA).toBeLessThan(tieIndexB);
  });

  it('does not count a closed tender with no winners as awarded', () => {
    const stats = buildDashboardStats([makeTender({ winners: null })]);
    expect(stats.totalAwardedCount).toBe(0);
    expect(stats.byMinistry).toEqual([]);
  });

  it('does not count an open tender with winners as awarded', () => {
    const stats = buildDashboardStats([makeTender({ status: 'open' })]);
    expect(stats.totalAwardedCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- dashboard.test.ts`
Expected: FAIL — `Cannot find module '../src/query/dashboard.js'`

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/query/dashboard.ts
import type { Tender } from '@tms/shared';

export interface MinistryStat {
  ministry: string;
  totalValue: number;
  count: number;
}

export interface ContractorStat {
  name: string;
  wins: number;
  totalValue: number;
}

export interface YearStat {
  year: number;
  totalValue: number;
}

export interface DashboardStats {
  totalAwardedValue: number;
  totalAwardedCount: number;
  excludedFromValueCount: number;
  byMinistry: MinistryStat[];
  topContractors: ContractorStat[];
  byYear: YearStat[];
}

function isAwarded(t: Tender): boolean {
  return t.status === 'closed' && t.winners !== null && t.winners.length > 0;
}

export function buildDashboardStats(tenders: Tender[]): DashboardStats {
  const awarded = tenders.filter(isAwarded);

  let totalAwardedValue = 0;
  let excludedFromValueCount = 0;
  const ministryMap = new Map<string, MinistryStat>();
  const contractorMap = new Map<string, ContractorStat>();
  const yearMap = new Map<number, YearStat>();

  for (const t of awarded) {
    const ministryKey = t.ministry ?? 'Unknown';
    const ministryStat = ministryMap.get(ministryKey) ?? { ministry: ministryKey, totalValue: 0, count: 0 };
    ministryStat.count += 1;
    ministryMap.set(ministryKey, ministryStat);

    const dateStr = t.closingDate ?? t.advertisedDate;
    const year = dateStr ? Number(dateStr.slice(0, 4)) : null;
    let yearStat: YearStat | null = null;
    if (year !== null) {
      yearStat = yearMap.get(year) ?? { year, totalValue: 0 };
      yearMap.set(year, yearStat);
    }

    for (const winner of t.winners ?? []) {
      const contractorStat = contractorMap.get(winner.name) ?? { name: winner.name, wins: 0, totalValue: 0 };
      contractorStat.wins += 1;
      contractorMap.set(winner.name, contractorStat);

      if (winner.price === null) {
        excludedFromValueCount += 1;
        continue;
      }

      contractorStat.totalValue += winner.price;
      ministryStat.totalValue += winner.price;
      totalAwardedValue += winner.price;
      if (yearStat) yearStat.totalValue += winner.price;
    }
  }

  const byMinistry = [...ministryMap.values()].sort((a, b) => b.totalValue - a.totalValue).slice(0, 10);
  const topContractors = [...contractorMap.values()]
    .sort((a, b) => (b.wins - a.wins) || (b.totalValue - a.totalValue))
    .slice(0, 10);
  const byYear = [...yearMap.values()].sort((a, b) => a.year - b.year);

  return {
    totalAwardedValue,
    totalAwardedCount: awarded.length,
    excludedFromValueCount,
    byMinistry,
    topContractors,
    byYear,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend -- dashboard.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/query/dashboard.ts backend/test/dashboard.test.ts
git commit -m "feat(backend): add buildDashboardStats awarded-tender aggregation"
```

---

### Task 2: Backend — `GET /api/dashboard` endpoint

**Files:**
- Modify: `backend/src/api/app.ts`
- Test: `backend/test/app.test.ts`

**Interfaces:**
- Consumes: `buildDashboardStats` from Task 1 (`backend/src/query/dashboard.js`),
  `deps.repo.getAll(): Tender[]` (already used by the existing `/api/tenders/facets` route
  in this same file).
- Produces: `GET /api/dashboard` → 200 with a `DashboardStats` JSON body.

- [ ] **Step 1: Write the failing test**

Add to `backend/test/app.test.ts` (this file already has a `patch()` fixture helper and a
`beforeEach` that builds `repo`/`manager`/`app` — reuse them, do not redefine):

```ts
  it('GET /api/dashboard returns awarded-tender aggregate stats', async () => {
    repo.mergeMany([
      patch({
        status: 'closed', ministry: 'KEMENTERIAN A', closingDate: '2025-01-10',
        winners: [{ name: 'ACME SDN BHD', price: 500 }],
      }),
      patch({ status: 'open' }), // not awarded — must not affect the stats
    ]);
    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.totalAwardedCount).toBe(1);
    expect(res.body.totalAwardedValue).toBe(500);
    expect(res.body.byMinistry).toEqual([{ ministry: 'KEMENTERIAN A', totalValue: 500, count: 1 }]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend -- app.test.ts`
Expected: FAIL — 404 (route doesn't exist yet)

- [ ] **Step 3: Add the route**

In `backend/src/api/app.ts`, add the import alongside the existing `query/tenders.js`
import:

```ts
import { buildDashboardStats } from '../query/dashboard.js';
```

Add the route directly after the existing `/api/tenders/facets` route:

```ts
  app.get('/api/dashboard', (_req, res) => {
    res.json(buildDashboardStats(deps.repo.getAll()));
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend`
Expected: PASS (all backend tests, including the new one)

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/app.ts backend/test/app.test.ts
git commit -m "feat(backend): add GET /api/dashboard endpoint"
```

---

### Task 3: Frontend — `formatMYR` shared currency helper

**Files:**
- Create: `frontend/src/lib/format.ts`
- Test: `frontend/src/test/format.test.ts`

**Interfaces:**
- Produces: `formatMYR(n: number): string` — consumed by Task 4's `DashboardPage`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/test/format.test.ts
import { describe, expect, it } from 'vitest';
import { formatMYR } from '../lib/format';

describe('formatMYR', () => {
  it('formats a number with thousands separators and 2 decimal places, RM-prefixed', () => {
    expect(formatMYR(1234567.5)).toBe('RM 1,234,567.50');
  });

  it('formats zero correctly', () => {
    expect(formatMYR(0)).toBe('RM 0.00');
  });

  it('formats a whole number with two trailing zeros', () => {
    expect(formatMYR(600000)).toBe('RM 600,000.00');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w frontend -- format.test.ts`
Expected: FAIL — `Cannot find module '../lib/format'`

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/lib/format.ts
export function formatMYR(n: number): string {
  return `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w frontend -- format.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/format.ts frontend/src/test/format.test.ts
git commit -m "feat(frontend): add formatMYR shared currency formatter"
```

---

### Task 4: Frontend — API types/client + `DashboardPage`

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/test/mocks.ts`
- Create: `frontend/src/pages/DashboardPage.tsx`
- Test: `frontend/src/test/DashboardPage.test.tsx`

**Interfaces:**
- Consumes: `formatMYR` from Task 3 (`../lib/format`). Response shape matches Task 1's
  `DashboardStats`/`MinistryStat`/`ContractorStat`/`YearStat` field-for-field (this file
  defines its own copies, same as `Tender`/`Facets` already do for other endpoints in this
  codebase — no shared import between backend and frontend beyond the `@tms/shared`
  package).
- Produces: `DashboardPage` default export — consumed by Task 5's route wiring.

- [ ] **Step 1: Write the failing test**

First, add the fixture and default MSW handler to `frontend/src/test/mocks.ts` (add the
import and these two exports/handler; do not remove any existing content in this file):

```ts
// add to the type import at the top of frontend/src/test/mocks.ts:
import type { DashboardStats, Facets, ScrapeSource, ScrapeStatus, Tender, TenderPage } from '../api/types';
```

```ts
// add alongside the other `export const default...` fixtures:
export const defaultDashboardStats: DashboardStats = {
  totalAwardedValue: 1000000,
  totalAwardedCount: 42,
  excludedFromValueCount: 3,
  byMinistry: [
    { ministry: 'KEMENTERIAN A', totalValue: 600000, count: 3 },
    { ministry: 'KEMENTERIAN B', totalValue: 400000, count: 2 },
  ],
  topContractors: [
    { name: 'ACME SDN BHD', wins: 5, totalValue: 700000 },
    { name: 'BETA ENGINEERING', wins: 2, totalValue: 300000 },
  ],
  byYear: [
    { year: 2024, totalValue: 400000 },
    { year: 2025, totalValue: 600000 },
  ],
};
```

```ts
// add to the `handlers` array:
  http.get('/api/dashboard', () => HttpResponse.json(defaultDashboardStats)),
```

Now write `frontend/src/test/DashboardPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import DashboardPage from '../pages/DashboardPage';
import { defaultDashboardStats, server } from './mocks';

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DashboardPage />
    </QueryClientProvider>,
  );
}

describe('DashboardPage', () => {
  it('shows headline totals', async () => {
    renderDashboard();
    expect(await screen.findByText('RM 1,000,000.00')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('shows the excludes-N caption when excludedFromValueCount is greater than 0', async () => {
    renderDashboard();
    expect(await screen.findByText(/excludes 3 awards/i)).toBeInTheDocument();
  });

  it('hides the excludes caption when excludedFromValueCount is 0', async () => {
    server.use(http.get('/api/dashboard', () => HttpResponse.json({ ...defaultDashboardStats, excludedFromValueCount: 0 })));
    renderDashboard();
    await screen.findByText('RM 1,000,000.00');
    expect(screen.queryByText(/excludes/i)).not.toBeInTheDocument();
  });

  it('lists ministries by spend with value and count', async () => {
    renderDashboard();
    expect(await screen.findByText('KEMENTERIAN A')).toBeInTheDocument();
    expect(screen.getByText(/RM 600,000\.00 \(3\)/)).toBeInTheDocument();
  });

  it('lists top contractors with wins and value', async () => {
    renderDashboard();
    expect(await screen.findByText('ACME SDN BHD')).toBeInTheDocument();
    expect(screen.getByText(/5 wins/)).toBeInTheDocument();
  });

  it('shows awarded value by year in the order the API returned (ascending)', async () => {
    renderDashboard();
    const years = await screen.findAllByText(/^20\d{2}$/);
    expect(years.map((el) => el.textContent)).toEqual(['2024', '2025']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- DashboardPage.test.tsx`
Expected: FAIL — `Cannot find module '../pages/DashboardPage'`

- [ ] **Step 3: Add types, client function, and the page component**

Add to `frontend/src/api/types.ts` (append; do not remove existing exports):

```ts
export interface MinistryStat { ministry: string; totalValue: number; count: number }
export interface ContractorStat { name: string; wins: number; totalValue: number }
export interface YearStat { year: number; totalValue: number }
export interface DashboardStats {
  totalAwardedValue: number;
  totalAwardedCount: number;
  excludedFromValueCount: number;
  byMinistry: MinistryStat[];
  topContractors: ContractorStat[];
  byYear: YearStat[];
}
```

Add to `frontend/src/api/client.ts` (update the type-only import at the top to include
`DashboardStats`, and add the function alongside the other `fetch*` functions):

```ts
export function fetchDashboard(): Promise<DashboardStats> {
  return getJson('/api/dashboard');
}
```

Create `frontend/src/pages/DashboardPage.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { fetchDashboard } from '../api/client';
import { formatMYR } from '../lib/format';

function barPct(value: number, max: number): number {
  return max > 0 ? (value / max) * 100 : 0;
}

export default function DashboardPage() {
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: fetchDashboard });
  if (!data) return null;

  const maxMinistryValue = Math.max(0, ...data.byMinistry.map((m) => m.totalValue));
  const maxContractorWins = Math.max(0, ...data.topContractors.map((c) => c.wins));
  const maxYearValue = Math.max(0, ...data.byYear.map((y) => y.totalValue));

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="font-semibold text-lg">Dashboard</h1>

      <section className="flex gap-6">
        <div className="border border-[#e0e0e0] rounded-lg p-4 flex-1">
          <div className="text-xs text-gray-500">Total Awarded Value</div>
          <div className="text-lg font-semibold">{formatMYR(data.totalAwardedValue)}</div>
        </div>
        <div className="border border-[#e0e0e0] rounded-lg p-4 flex-1">
          <div className="text-xs text-gray-500">Total Awarded Tenders</div>
          <div className="text-lg font-semibold">{data.totalAwardedCount}</div>
        </div>
      </section>
      {data.excludedFromValueCount > 0 && (
        <div className="text-xs text-gray-500">
          Excludes {data.excludedFromValueCount} awards with no recorded price
        </div>
      )}

      <section>
        <h2 className="font-semibold mb-3">Spend by Ministry</h2>
        <div className="space-y-2">
          {data.byMinistry.map((m) => (
            <div key={m.ministry}>
              <div className="flex justify-between text-xs mb-1">
                <span>{m.ministry}</span>
                <span>{formatMYR(m.totalValue)} ({m.count})</span>
              </div>
              <div className="h-2 bg-gray-100 rounded">
                <div className="h-2 bg-blue-800 rounded" style={{ width: `${barPct(m.totalValue, maxMinistryValue)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-semibold mb-3">Top Contractors</h2>
        <div className="space-y-2">
          {data.topContractors.map((c) => (
            <div key={c.name}>
              <div className="flex justify-between text-xs mb-1">
                <span>{c.name}</span>
                <span>{c.wins} wins · {formatMYR(c.totalValue)}</span>
              </div>
              <div className="h-2 bg-gray-100 rounded">
                <div className="h-2 bg-blue-800 rounded" style={{ width: `${barPct(c.wins, maxContractorWins)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-semibold mb-3">Awarded Value by Year</h2>
        <div className="space-y-2">
          {data.byYear.map((y) => (
            <div key={y.year}>
              <div className="flex justify-between text-xs mb-1">
                <span>{y.year}</span>
                <span>{formatMYR(y.totalValue)}</span>
              </div>
              <div className="h-2 bg-gray-100 rounded">
                <div className="h-2 bg-blue-800 rounded" style={{ width: `${barPct(y.totalValue, maxYearValue)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w frontend`
Expected: PASS (all frontend tests, including the 6 new `DashboardPage` tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/test/mocks.ts \
  frontend/src/pages/DashboardPage.tsx frontend/src/test/DashboardPage.test.tsx
git commit -m "feat(frontend): add Dashboard page with ministry/contractor/year analytics"
```

---

### Task 5: Frontend — nav link and route

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/test/App.test.tsx`

**Interfaces:**
- Consumes: `DashboardPage` default export from Task 4 (`./pages/DashboardPage`).

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/test/App.test.tsx` (this file already imports `userEvent` and has a
similar test for the Settings link — follow that pattern):

```tsx
  it('renders a Dashboard link pinned first in the nav, leading to the Dashboard page', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('link', { name: 'Dashboard' }));
    expect(await screen.findByText('Spend by Ministry')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- App.test.tsx`
Expected: FAIL — no link named "Dashboard"

- [ ] **Step 3: Add the nav link and route**

In `frontend/src/App.tsx`, add the import:

```tsx
import DashboardPage from './pages/DashboardPage';
```

Add the nav link as the **first** entry in the existing `space-y-1` nav group (before
"Open Tenders"):

```tsx
              <NavLink to="/dashboard" className={navLinkClass}>Dashboard</NavLink>
```

Add the route as the first entry inside `<Routes>` (before the `/` redirect — order
doesn't affect matching here, but keep it visually first alongside the nav link):

```tsx
                <Route path="/dashboard" element={<DashboardPage />} />
```

Do not change the `/` → `/open` redirect — Dashboard is an additional nav entry, not the
new default landing page.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w frontend`
Expected: PASS (all frontend tests, including the new App test)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/test/App.test.tsx
git commit -m "feat(frontend): add Dashboard nav link and route"
```

---

## Final verification

After all 5 tasks: run `npm test` from the repo root and confirm every workspace (shared,
backend, frontend) passes, including all new tests from this plan.
