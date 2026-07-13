# Dashboard "See More" Detail Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "See more" links from the Dashboard's "Spend by Ministry" and "Top Contractors" sections to two new pages that show the complete ranked list (not just the top 10).

**Architecture:** `buildDashboardStats` (backend) already computes full ministry/contractor maps before slicing to the top 10 for the dashboard summary. We add two new fields (`allMinistries`, `allContractors`) carrying the unsliced, sorted lists, and expose them on the existing `/api/dashboard` response. Two new frontend routes reuse the same React Query cache entry (`['dashboard']`) that the Dashboard page already populates, so the detail pages render instantly with no extra network round trip.

**Tech Stack:** TypeScript, Express (backend), React + Vite + React Router + TanStack Query (frontend), Vitest + Testing Library + MSW for tests.

## Global Constraints

- Tests must never hit the real myprocurement.treasury.gov.my — not relevant here (no scraper changes), but keep using fixtures/fakes per project convention.
- TDD: write the failing test first, confirm it fails for the right reason, then implement minimally, then commit on green. Never commit red.
- Coverage thresholds (80% lines/branches) are enforced by vitest; don't lower them.
- Explain things in plain language in commit messages / comments only where the WHY is non-obvious — default to no comments.

---

### Task 1: Backend — expose full sorted ministry/contractor lists

**Files:**
- Modify: `backend/src/query/dashboard.ts`
- Modify: `backend/test/dashboard.test.ts`

**Interfaces:**
- Produces: `DashboardStats.allMinistries: MinistryStat[]` (every ministry with an awarded tender, sorted by `totalValue` descending — same sort as `byMinistry`, just unsliced).
- Produces: `DashboardStats.allContractors: ContractorStat[]` (every contractor with a win, sorted by `wins` descending then `totalValue` descending — same sort as `topContractors`, just unsliced).

- [ ] **Step 1: Write the failing tests**

Update the "zeros" test in `backend/test/dashboard.test.ts` (it currently does an exact `toEqual` on the whole result, so it will fail once we add fields even before we assert on them — update it now so it stays exact):

```ts
  it('returns zeros and empty lists for no tenders', () => {
    expect(buildDashboardStats([])).toEqual({
      totalAwardedValue: 0, totalAwardedCount: 0, excludedFromValueCount: 0,
      byMinistry: [], topContractors: [], byYear: [],
      allMinistries: [], allContractors: [],
    });
  });
```

Extend the existing top-10 truncation tests with assertions on the new full-list fields (add these `expect` lines at the end of each `it` block, don't remove anything already there):

In `'truncates to the top 10 ministries by total value, descending'`:

```ts
    expect(stats.allMinistries).toHaveLength(12);
    expect(stats.allMinistries[0]).toEqual({ ministry: 'MINISTRY 11', totalValue: 12000, count: 1 });
    expect(stats.allMinistries[11]).toEqual({ ministry: 'MINISTRY 0', totalValue: 1000, count: 1 });
```

In `'truncates to the top 10 contractors by win count, descending, ties broken by value'`:

```ts
    expect(stats.allContractors).toHaveLength(12);
    expect(stats.allContractors[0]).toEqual({ name: 'BIG WINNER', wins: 3, totalValue: 1500 });
    const allTieIndexA = stats.allContractors.findIndex((c) => c.name === 'TIE A');
    const allTieIndexB = stats.allContractors.findIndex((c) => c.name === 'TIE B');
    expect(allTieIndexA).toBeLessThan(allTieIndexB);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- dashboard.test.ts`
Expected: FAIL — `allMinistries`/`allContractors` are `undefined`, and the zeros test fails the `toEqual` because the actual object is missing the two new keys (TypeScript won't even compile until Step 3, since the fields don't exist on the type yet — that's expected at this point).

- [ ] **Step 3: Implement the minimal change**

In `backend/src/query/dashboard.ts`, add the two fields to the interface:

```ts
export interface DashboardStats {
  totalAwardedValue: number;
  totalAwardedCount: number;
  excludedFromValueCount: number;
  byMinistry: MinistryStat[];
  topContractors: ContractorStat[];
  byYear: YearStat[];
  allMinistries: MinistryStat[];
  allContractors: ContractorStat[];
}
```

Replace the tail of `buildDashboardStats` (from the `const byMinistry = ...` line to the end) with:

```ts
  const allMinistries = [...ministryMap.values()].sort((a, b) => b.totalValue - a.totalValue);
  const allContractors = [...contractorMap.values()]
    .sort((a, b) => (b.wins - a.wins) || (b.totalValue - a.totalValue));
  const byMinistry = allMinistries.slice(0, 10);
  const topContractors = allContractors.slice(0, 10);
  const byYear = [...yearMap.values()].sort((a, b) => a.year - b.year);

  return {
    totalAwardedValue,
    totalAwardedCount: awarded.length,
    excludedFromValueCount,
    byMinistry,
    topContractors,
    byYear,
    allMinistries,
    allContractors,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend -- dashboard.test.ts`
Expected: PASS (all tests in the file, including the ones just extended)

- [ ] **Step 5: Run the full backend suite to check nothing else broke**

Run: `npm test -w backend`
Expected: PASS — in particular `test/app.test.ts`'s `GET /api/dashboard` test still passes since it only asserts specific fields, not the whole shape.

- [ ] **Step 6: Commit**

```bash
git add backend/src/query/dashboard.ts backend/test/dashboard.test.ts
git commit -m "feat: expose full sorted ministry/contractor lists from dashboard stats"
```

---

### Task 2: Frontend — extend API types and test fixtures

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/test/mocks.ts`

**Interfaces:**
- Consumes: nothing new (mirrors Task 1's backend shape).
- Produces: `DashboardStats` type now includes `allMinistries: MinistryStat[]` and `allContractors: ContractorStat[]`. `defaultDashboardStats` test fixture gets 3 ministries and 3 contractors in `allMinistries`/`allContractors` (one more than the 2 already in `byMinistry`/`topContractors`) so later tests can distinguish "full list" rendering from "top list" rendering.

- [ ] **Step 1: Update the type**

In `frontend/src/api/types.ts`, change:

```ts
export interface DashboardStats {
  totalAwardedValue: number;
  totalAwardedCount: number;
  excludedFromValueCount: number;
  byMinistry: MinistryStat[];
  topContractors: ContractorStat[];
  byYear: YearStat[];
}
```

to:

```ts
export interface DashboardStats {
  totalAwardedValue: number;
  totalAwardedCount: number;
  excludedFromValueCount: number;
  byMinistry: MinistryStat[];
  topContractors: ContractorStat[];
  byYear: YearStat[];
  allMinistries: MinistryStat[];
  allContractors: ContractorStat[];
}
```

- [ ] **Step 2: Update the test fixture**

In `frontend/src/test/mocks.ts`, change `defaultDashboardStats` to:

```ts
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
  allMinistries: [
    { ministry: 'KEMENTERIAN A', totalValue: 600000, count: 3 },
    { ministry: 'KEMENTERIAN B', totalValue: 400000, count: 2 },
    { ministry: 'KEMENTERIAN C', totalValue: 100000, count: 1 },
  ],
  allContractors: [
    { name: 'ACME SDN BHD', wins: 5, totalValue: 700000 },
    { name: 'BETA ENGINEERING', wins: 2, totalValue: 300000 },
    { name: 'GAMMA WORKS', wins: 1, totalValue: 50000 },
  ],
};
```

- [ ] **Step 3: Run the frontend typecheck and existing dashboard test**

Run: `npm run build -w frontend`
Expected: PASS (no type errors — `DashboardPage.tsx` doesn't reference the new fields yet, so nothing breaks)

Run: `npm test -w frontend -- DashboardPage.test.tsx`
Expected: PASS (existing tests only look at `byMinistry`/`topContractors`/`byYear`, unaffected by the new fixture fields)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/test/mocks.ts
git commit -m "feat: add allMinistries/allContractors to DashboardStats type and test fixture"
```

---

### Task 3: Frontend — MinistryDetailPage

**Files:**
- Create: `frontend/src/pages/MinistryDetailPage.tsx`
- Create: `frontend/src/test/MinistryDetailPage.test.tsx`

**Interfaces:**
- Consumes: `fetchDashboard` from `frontend/src/api/client.ts` (existing, returns `Promise<DashboardStats>`), `formatMYR` from `frontend/src/lib/format.ts` (existing).
- Produces: default-exported `MinistryDetailPage` React component, rendered at route `/dashboard/ministries` (wired in Task 5).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/test/MinistryDetailPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import MinistryDetailPage from '../pages/MinistryDetailPage';
import { defaultDashboardStats } from './mocks';

function FakeDashboardPage() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/dashboard/ministries')}>GO TO MINISTRIES</button>;
}

function renderPage({ prefetch = true } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (prefetch) {
    qc.setQueryData(['dashboard'], defaultDashboardStats);
  }
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/dashboard', '/dashboard/ministries']} initialIndex={1}>
        <Routes>
          <Route path="/dashboard" element={<FakeDashboardPage />} />
          <Route path="/dashboard/ministries" element={<MinistryDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MinistryDetailPage', () => {
  it('lists every ministry, including ones beyond the dashboard top 10, sorted by spend', async () => {
    renderPage();
    expect(await screen.findByText('KEMENTERIAN A')).toBeInTheDocument();
    expect(screen.getByText('KEMENTERIAN B')).toBeInTheDocument();
    expect(screen.getByText('KEMENTERIAN C')).toBeInTheDocument();
    expect(screen.getByText(/RM 600,000\.00 \(3\)/)).toBeInTheDocument();
    expect(screen.getByText(/RM 100,000\.00 \(1\)/)).toBeInTheDocument();
  });

  it('navigates back when the back link is clicked', async () => {
    renderPage();
    await screen.findByText('KEMENTERIAN A');
    await userEvent.click(screen.getByRole('button', { name: /back to dashboard/i }));
    expect(await screen.findByText('GO TO MINISTRIES')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- MinistryDetailPage.test.tsx`
Expected: FAIL — `Failed to resolve import "../pages/MinistryDetailPage"` (module doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/src/pages/MinistryDetailPage.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { fetchDashboard } from '../api/client';
import { formatMYR } from '../lib/format';

function barPct(value: number, max: number): number {
  return max > 0 ? (value / max) * 100 : 0;
}

export default function MinistryDetailPage() {
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: fetchDashboard });
  if (!data) return null;

  const maxValue = Math.max(0, ...data.allMinistries.map((m) => m.totalValue));

  return (
    <div className="max-w-4xl space-y-6">
      <button type="button" onClick={() => navigate(-1)} className="text-blue-700 underline">
        ← Back to dashboard
      </button>
      <h1 className="font-semibold text-lg">Spend by Ministry — All {data.allMinistries.length} Ministries</h1>
      <div className="space-y-2">
        {data.allMinistries.map((m) => (
          <div key={m.ministry}>
            <div className="flex justify-between text-xs mb-1">
              <span>{m.ministry}</span>
              <span>{formatMYR(m.totalValue)} ({m.count})</span>
            </div>
            <div className="h-2 bg-gray-100 rounded">
              <div className="h-2 bg-blue-800 rounded" style={{ width: `${barPct(m.totalValue, maxValue)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend -- MinistryDetailPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/MinistryDetailPage.tsx frontend/src/test/MinistryDetailPage.test.tsx
git commit -m "feat: add MinistryDetailPage showing the full ranked ministry list"
```

---

### Task 4: Frontend — ContractorDetailPage

**Files:**
- Create: `frontend/src/pages/ContractorDetailPage.tsx`
- Create: `frontend/src/test/ContractorDetailPage.test.tsx`

**Interfaces:**
- Consumes: same as Task 3 (`fetchDashboard`, `formatMYR`).
- Produces: default-exported `ContractorDetailPage` React component, rendered at route `/dashboard/contractors` (wired in Task 5).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/test/ContractorDetailPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ContractorDetailPage from '../pages/ContractorDetailPage';
import { defaultDashboardStats } from './mocks';

function FakeDashboardPage() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/dashboard/contractors')}>GO TO CONTRACTORS</button>;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['dashboard'], defaultDashboardStats);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/dashboard', '/dashboard/contractors']} initialIndex={1}>
        <Routes>
          <Route path="/dashboard" element={<FakeDashboardPage />} />
          <Route path="/dashboard/contractors" element={<ContractorDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ContractorDetailPage', () => {
  it('lists every contractor, including ones beyond the dashboard top 10, with wins and value', async () => {
    renderPage();
    expect(await screen.findByText('ACME SDN BHD')).toBeInTheDocument();
    expect(screen.getByText('BETA ENGINEERING')).toBeInTheDocument();
    expect(screen.getByText('GAMMA WORKS')).toBeInTheDocument();
    expect(screen.getByText(/5 wins · RM 700,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/1 wins · RM 50,000\.00/)).toBeInTheDocument();
  });

  it('navigates back when the back link is clicked', async () => {
    renderPage();
    await screen.findByText('ACME SDN BHD');
    await userEvent.click(screen.getByRole('button', { name: /back to dashboard/i }));
    expect(await screen.findByText('GO TO CONTRACTORS')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- ContractorDetailPage.test.tsx`
Expected: FAIL — `Failed to resolve import "../pages/ContractorDetailPage"`.

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/src/pages/ContractorDetailPage.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { fetchDashboard } from '../api/client';
import { formatMYR } from '../lib/format';

function barPct(value: number, max: number): number {
  return max > 0 ? (value / max) * 100 : 0;
}

export default function ContractorDetailPage() {
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: fetchDashboard });
  if (!data) return null;

  const maxWins = Math.max(0, ...data.allContractors.map((c) => c.wins));

  return (
    <div className="max-w-4xl space-y-6">
      <button type="button" onClick={() => navigate(-1)} className="text-blue-700 underline">
        ← Back to dashboard
      </button>
      <h1 className="font-semibold text-lg">Top Contractors — All {data.allContractors.length} Contractors</h1>
      <div className="space-y-2">
        {data.allContractors.map((c) => (
          <div key={c.name}>
            <div className="flex justify-between text-xs mb-1">
              <span>{c.name}</span>
              <span>{c.wins} wins · {formatMYR(c.totalValue)}</span>
            </div>
            <div className="h-2 bg-gray-100 rounded">
              <div className="h-2 bg-blue-800 rounded" style={{ width: `${barPct(c.wins, maxWins)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend -- ContractorDetailPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/ContractorDetailPage.tsx frontend/src/test/ContractorDetailPage.test.tsx
git commit -m "feat: add ContractorDetailPage showing the full ranked contractor list"
```

---

### Task 5: Wire routes and add "See more" links on the Dashboard

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/DashboardPage.tsx`
- Modify: `frontend/src/test/DashboardPage.test.tsx`

**Interfaces:**
- Consumes: `MinistryDetailPage` (Task 3), `ContractorDetailPage` (Task 4).
- Produces: routes `/dashboard/ministries` and `/dashboard/contractors` registered in the app router; "See more →" links visible in the Dashboard's Ministry and Contractor section headers.

- [ ] **Step 1: Write the failing test**

`DashboardPage.tsx` currently isn't rendered inside a Router in its test, but it will now render `<Link>` elements, which requires a Router context. Update `frontend/src/test/DashboardPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import DashboardPage from '../pages/DashboardPage';
import { defaultDashboardStats, server } from './mocks';

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
```

(Keep the rest of the file's existing `describe`/`it` blocks unchanged.) Add two new tests at the end of the `describe('DashboardPage', ...)` block:

```tsx
  it('links "See more" on Spend by Ministry to /dashboard/ministries', async () => {
    renderDashboard();
    await screen.findByText('KEMENTERIAN A');
    const links = screen.getAllByRole('link', { name: /see more/i });
    const ministryLink = links.find((l) => l.getAttribute('href') === '/dashboard/ministries');
    expect(ministryLink).toBeDefined();
  });

  it('links "See more" on Top Contractors to /dashboard/contractors', async () => {
    renderDashboard();
    await screen.findByText('ACME SDN BHD');
    const links = screen.getAllByRole('link', { name: /see more/i });
    const contractorLink = links.find((l) => l.getAttribute('href') === '/dashboard/contractors');
    expect(contractorLink).toBeDefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w frontend -- DashboardPage.test.tsx`
Expected: FAIL — the two new tests fail because no "See more" links exist yet. (The other tests should still pass since `MemoryRouter` wrapping doesn't change their assertions — this confirms the Router wrapper change itself isn't the failure.)

- [ ] **Step 3: Implement**

In `frontend/src/App.tsx`, add the two imports and routes:

```tsx
import DashboardPage from './pages/DashboardPage';
import DetailPage from './pages/DetailPage';
import MinistryDetailPage from './pages/MinistryDetailPage';
import ContractorDetailPage from './pages/ContractorDetailPage';
import SettingsPage from './pages/SettingsPage';
import TenderListPage from './pages/TenderListPage';
```

and inside `<Routes>`, add after the `/dashboard` route:

```tsx
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/dashboard/ministries" element={<MinistryDetailPage />} />
                <Route path="/dashboard/contractors" element={<ContractorDetailPage />} />
```

In `frontend/src/pages/DashboardPage.tsx`, add the import:

```tsx
import { Link } from 'react-router-dom';
```

Change the "Spend by Ministry" section header from:

```tsx
      <section>
        <h2 className="font-semibold mb-3">Spend by Ministry</h2>
```

to:

```tsx
      <section>
        <div className="flex justify-between items-center mb-3">
          <h2 className="font-semibold">Spend by Ministry</h2>
          <Link to="/dashboard/ministries" className="text-xs text-blue-700 underline">See more →</Link>
        </div>
```

Change the "Top Contractors" section header from:

```tsx
      <section>
        <h2 className="font-semibold mb-3">Top Contractors</h2>
```

to:

```tsx
      <section>
        <div className="flex justify-between items-center mb-3">
          <h2 className="font-semibold">Top Contractors</h2>
          <Link to="/dashboard/contractors" className="text-xs text-blue-700 underline">See more →</Link>
        </div>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w frontend -- DashboardPage.test.tsx`
Expected: PASS (all tests, including the two new ones)

- [ ] **Step 5: Run the full frontend suite**

Run: `npm test -w frontend`
Expected: PASS (all test files, including `MinistryDetailPage.test.tsx` and `ContractorDetailPage.test.tsx` from Tasks 3–4)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx frontend/src/pages/DashboardPage.tsx frontend/src/test/DashboardPage.test.tsx
git commit -m "feat: wire dashboard ministry/contractor detail routes with See more links"
```

---

### Task 6: Live verification in the browser

**Files:** none (manual verification step, per `.claude/skills/e2e-playwright-verification/SKILL.md`)

- [ ] **Step 1: Run the full monorepo test suite once more**

Run: `npm test`
Expected: PASS (all workspaces — shared, backend, frontend)

- [ ] **Step 2: Start dev servers**

Run: `npm run dev -w backend` (port 3001) and `npm run dev -w frontend` (port 5173), or use the Browser pane's `preview_start` tool per the project's E2E skill.

- [ ] **Step 3: Drive the browser through the feature**

Using the Playwright/Browser MCP tools:
1. Navigate to `http://localhost:5173/dashboard`.
2. Confirm "See more →" appears next to both "Spend by Ministry" and "Top Contractors".
3. Click "See more →" next to Spend by Ministry. Confirm the URL is `/dashboard/ministries` and the page lists more than 10 ministries (assuming real data has more than 10).
4. Click "← Back to dashboard". Confirm it returns to `/dashboard`.
5. Repeat steps 3–4 for "Top Contractors" → `/dashboard/contractors`.
6. Check `read_console_messages` / `preview_logs` for errors.

- [ ] **Step 4: Report results**

Summarize what was checked and observed (no code changes in this task — it's verification only).
