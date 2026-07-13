# Modern SaaS-style UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the tender list and sidebar UI into a clean, minimal SaaS look (Linear/Stripe/Vercel-style) — colored badges, a days-left urgency indicator, row actions, stat cards on the Open Tenders page, sticky/zebra table, and a light-gray/white card visual system — without changing any existing data shapes or API behavior.

**Architecture:** Small presentational components (`Badge`, `DaysLeftBadge`, `StatCard`) built and unit-tested in isolation first, then wired into the existing `TenderListPage.tsx` and `App.tsx`. Stat cards reuse the existing `/api/tenders` and `/api/dashboard` endpoints with different query params — no backend changes.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, TanStack Query, Vitest + Testing Library + MSW.

## Global Constraints

- Do not change any existing API request/response shapes, backend code, or `shared/` schema — frontend-only.
- Do not regress any existing passing test in `TenderListPage.test.tsx` or `App.test.tsx` — update assertions only where the redesign genuinely changes markup (e.g. Source column becomes badges instead of a joined string).
- New components each get their own test file, written before the implementation (TDD).
- No new npm dependencies (icons are inline SVG, not an icon library).
- Font stays Inter (already loaded); no new font added.
- Coverage thresholds (80% lines/branches) must still pass — new components need real test coverage, not just smoke tests.
- Run the full workspace test suite (`npm test`) before each commit; pre-commit hook already enforces this — never use `--no-verify`.

---

### Task 1: Date-range helpers

**Files:**
- Create: `frontend/src/lib/dateRange.ts`
- Test: `frontend/src/test/dateRange.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions, uses `Date`/`Date.now()`).
- Produces: `todayISO(): string`, `addDaysISO(base: string, days: number): string`, `daysUntil(closingDate: string): number` — consumed by Task 3 (`DaysLeftBadge`) and Task 7 (stat card queries).

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/test/dateRange.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDaysISO, daysUntil, todayISO } from '../lib/dateRange';

describe('dateRange', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T09:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('todayISO returns the current date as YYYY-MM-DD', () => {
    expect(todayISO()).toBe('2026-07-13');
  });

  it('addDaysISO adds whole days to a base ISO date', () => {
    expect(addDaysISO('2026-07-13', 7)).toBe('2026-07-20');
  });

  it('addDaysISO handles month rollover', () => {
    expect(addDaysISO('2026-07-28', 5)).toBe('2026-08-02');
  });

  describe('daysUntil', () => {
    it('returns 0 when the closing date is today', () => {
      expect(daysUntil('2026-07-13')).toBe(0);
    });

    it('returns a positive count for a future date', () => {
      expect(daysUntil('2026-07-20')).toBe(7);
    });

    it('returns a negative count for a past date', () => {
      expect(daysUntil('2026-07-10')).toBe(-3);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- dateRange.test.ts`
Expected: FAIL with "Cannot find module '../lib/dateRange'"

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/lib/dateRange.ts
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysISO(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysUntil(closingDate: string): number {
  const MS_PER_DAY = 86_400_000;
  const diff = Date.parse(`${closingDate}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`);
  return Math.round(diff / MS_PER_DAY);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend -- dateRange.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/dateRange.ts frontend/src/test/dateRange.test.ts
git commit -m "feat: add date-range helpers for stat cards and days-left badge"
```

---

### Task 2: `Badge` component

**Files:**
- Create: `frontend/src/components/Badge.tsx`
- Test: `frontend/src/test/Badge.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `export default function Badge({ label, colorKey }: { label: string; colorKey?: string }): JSX.Element` — consumed by Task 6 (Type/Source/Field Code columns).

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/test/Badge.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Badge from '../components/Badge';

describe('Badge', () => {
  it('renders the label text', () => {
    render(<Badge label="quotation" />);
    expect(screen.getByText('quotation')).toBeInTheDocument();
  });

  it('applies a known color for a recognized colorKey (case-insensitive)', () => {
    render(<Badge label="Quotation" colorKey="Quotation" />);
    expect(screen.getByText('Quotation')).toHaveClass('bg-blue-100');
  });

  it('falls back to a neutral gray style for an unrecognized colorKey', () => {
    render(<Badge label="060501" colorKey="060501" />);
    expect(screen.getByText('060501')).toHaveClass('bg-gray-100');
  });

  it('uses the label itself as the color key when colorKey is omitted', () => {
    render(<Badge label="span" />);
    expect(screen.getByText('span')).toHaveClass('bg-indigo-100');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- Badge.test.tsx`
Expected: FAIL with "Cannot find module '../components/Badge'"

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/components/Badge.tsx
interface Props {
  label: string;
  colorKey?: string;
}

const COLOR_MAP: Record<string, string> = {
  quotation: 'bg-blue-100 text-blue-700',
  tender: 'bg-purple-100 text-purple-700',
  myprocurement: 'bg-teal-100 text-teal-700',
  span: 'bg-indigo-100 text-indigo-700',
  kwsp: 'bg-amber-100 text-amber-700',
};
const NEUTRAL = 'bg-gray-100 text-gray-700';

export default function Badge({ label, colorKey }: Props) {
  const key = (colorKey ?? label).toLowerCase();
  const className = COLOR_MAP[key] ?? NEUTRAL;
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap ${className}`}>
      {label}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend -- Badge.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Badge.tsx frontend/src/test/Badge.test.tsx
git commit -m "feat: add Badge component for colored pill labels"
```

---

### Task 3: `DaysLeftBadge` component

**Files:**
- Create: `frontend/src/components/DaysLeftBadge.tsx`
- Test: `frontend/src/test/DaysLeftBadge.test.tsx`

**Interfaces:**
- Consumes: `daysUntil` from `frontend/src/lib/dateRange.ts` (Task 1).
- Produces: `export default function DaysLeftBadge({ closingDate }: { closingDate: string | null }): JSX.Element | null` — consumed by Task 6 (Closing Date column). Renders `data-testid="days-left"` on its root element.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/test/DaysLeftBadge.test.tsx
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DaysLeftBadge from '../components/DaysLeftBadge';

describe('DaysLeftBadge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T09:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when closingDate is null', () => {
    const { container } = render(<DaysLeftBadge closingDate={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows red "Today" when closing today', () => {
    render(<DaysLeftBadge closingDate="2026-07-13" />);
    const el = screen.getByTestId('days-left');
    expect(el).toHaveTextContent('Today');
    expect(el).toHaveClass('bg-red-100');
  });

  it('shows red "Overdue" when the closing date has passed', () => {
    render(<DaysLeftBadge closingDate="2026-07-10" />);
    const el = screen.getByTestId('days-left');
    expect(el).toHaveTextContent('Overdue');
    expect(el).toHaveClass('bg-red-100');
  });

  it('shows orange "Nd left" when closing within 7 days', () => {
    render(<DaysLeftBadge closingDate="2026-07-18" />);
    const el = screen.getByTestId('days-left');
    expect(el).toHaveTextContent('5d left');
    expect(el).toHaveClass('bg-orange-100');
  });

  it('shows green "Nd left" when closing more than 7 days out', () => {
    render(<DaysLeftBadge closingDate="2026-08-01" />);
    const el = screen.getByTestId('days-left');
    expect(el).toHaveTextContent('19d left');
    expect(el).toHaveClass('bg-green-100');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- DaysLeftBadge.test.tsx`
Expected: FAIL with "Cannot find module '../components/DaysLeftBadge'"

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/components/DaysLeftBadge.tsx
import { daysUntil } from '../lib/dateRange';

interface Props {
  closingDate: string | null;
}

export default function DaysLeftBadge({ closingDate }: Props) {
  if (closingDate === null) return null;
  const days = daysUntil(closingDate);

  let color: string;
  let label: string;
  if (days < 0) {
    color = 'bg-red-100 text-red-700';
    label = 'Overdue';
  } else if (days === 0) {
    color = 'bg-red-100 text-red-700';
    label = 'Today';
  } else if (days <= 7) {
    color = 'bg-orange-100 text-orange-700';
    label = `${days}d left`;
  } else {
    color = 'bg-green-100 text-green-700';
    label = `${days}d left`;
  }

  return (
    <span
      data-testid="days-left"
      className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap ${color}`}
    >
      {label}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend -- DaysLeftBadge.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/DaysLeftBadge.tsx frontend/src/test/DaysLeftBadge.test.tsx
git commit -m "feat: add DaysLeftBadge urgency indicator"
```

---

### Task 4: `StatCard` component

**Files:**
- Create: `frontend/src/components/StatCard.tsx`
- Test: `frontend/src/test/StatCard.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `export default function StatCard({ label, value }: { label: string; value: string | number }): JSX.Element` — consumed by Task 7 (Open Tenders header stats).

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/test/StatCard.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import StatCard from '../components/StatCard';

describe('StatCard', () => {
  it('renders the label and value', () => {
    render(<StatCard label="Open Tenders" value={128} />);
    expect(screen.getByText('Open Tenders')).toBeInTheDocument();
    expect(screen.getByText('128')).toBeInTheDocument();
  });

  it('renders a string value as-is', () => {
    render(<StatCard label="Awarded" value="—" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- StatCard.test.tsx`
Expected: FAIL with "Cannot find module '../components/StatCard'"

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/components/StatCard.tsx
interface Props {
  label: string;
  value: string | number;
}

export default function StatCard({ label, value }: Props) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-semibold mt-1">{value}</div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend -- StatCard.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/StatCard.tsx frontend/src/test/StatCard.test.tsx
git commit -m "feat: add StatCard component"
```

---

### Task 5: Sidebar icons and page background

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/test/App.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks (leaf change).

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/test/App.test.tsx`, inside the existing `describe('App', ...)` block:

```tsx
  it('renders an icon next to each nav link', () => {
    render(<App />);
    for (const name of ['Dashboard', 'Open Tenders', 'Closed Tenders', 'Awarded Tenders', 'Settings']) {
      const link = screen.getByRole('link', { name });
      expect(link.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
    }
  });

  it('gives the main content area a light gray background', () => {
    render(<App />);
    expect(screen.getByRole('main')).toHaveClass('bg-[#F8FAFC]');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- App.test.tsx`
Expected: FAIL — no `svg` found in nav links, and `main` lacks the `bg-[#F8FAFC]` class

- [ ] **Step 3: Write minimal implementation**

Replace the full contents of `frontend/src/App.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import DashboardPage from './pages/DashboardPage';
import DetailPage from './pages/DetailPage';
import MinistryDetailPage from './pages/MinistryDetailPage';
import ContractorDetailPage from './pages/ContractorDetailPage';
import SettingsPage from './pages/SettingsPage';
import TenderListPage from './pages/TenderListPage';

const queryClient = new QueryClient();

function Icon({ path }: { path: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d={path} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ICONS = {
  dashboard: 'M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6V11h-6v9zm0-16v5h6V4h-6z',
  open: 'M12 4v16m8-8H4',
  closed: 'M6 6l12 12M18 6L6 18',
  awarded: 'M12 15l-5.5 3 1.5-6.5L3 7l6.5-.5L12 1l2.5 5.5L21 7l-5 4.5 1.5 6.5z',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zm7-3a7 7 0 01-.1 1.2l2 1.6-2 3.4-2.3-1a7.3 7.3 0 01-2 1.2L14 22h-4l-.6-2.6a7.3 7.3 0 01-2-1.2l-2.3 1-2-3.4 2-1.6A7 7 0 015 12c0-.4 0-.8.1-1.2l-2-1.6 2-3.4 2.3 1a7.3 7.3 0 012-1.2L10 2h4l.6 2.6a7.3 7.3 0 012 1.2l2.3-1 2 3.4-2 1.6c.1.4.1.8.1 1.2z',
};

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return `flex items-center gap-2 px-4 py-2 rounded-md text-[12px] ${isActive ? 'bg-blue-800 text-white font-medium' : 'text-blue-900 hover:bg-blue-50'}`;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="flex h-screen">
          <nav className="w-56 shrink-0 bg-white border-r border-[#e0e0e0] p-4 flex flex-col overflow-y-auto">
            <div className="text-hero font-semibold text-blue-900 mb-4">Malaysia Tender Aggregator</div>
            <div className="space-y-1">
              <NavLink to="/dashboard" className={navLinkClass}><Icon path={ICONS.dashboard} />Dashboard</NavLink>
              <NavLink to="/open" className={navLinkClass}><Icon path={ICONS.open} />Open Tenders</NavLink>
              <NavLink to="/closed" className={navLinkClass}><Icon path={ICONS.closed} />Closed Tenders</NavLink>
              <NavLink to="/awarded" className={navLinkClass}><Icon path={ICONS.awarded} />Awarded Tenders</NavLink>
            </div>
            <div className="mt-auto">
              <NavLink to="/settings" className={navLinkClass}><Icon path={ICONS.settings} />Settings</NavLink>
            </div>
          </nav>
          <div className="flex-1 flex flex-col overflow-y-auto">
            <header className="bg-blue-900 text-white px-6 py-4 flex items-center justify-end shrink-0" />
            <main className="p-6 flex-1 bg-[#F8FAFC]">
              <Routes>
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/dashboard/ministries" element={<MinistryDetailPage />} />
                <Route path="/dashboard/contractors" element={<ContractorDetailPage />} />
                <Route path="/" element={<Navigate to="/open" replace />} />
                <Route path="/open" element={<TenderListPage status="open" showHeader />} />
                <Route path="/closed" element={<TenderListPage status="closed" />} />
                <Route path="/awarded" element={<TenderListPage status="closed" hasWinners />} />
                <Route path="/tenders/:refNo" element={<DetailPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </main>
          </div>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
```

Note: `<main>` has no explicit ARIA role attribute but browsers expose `<main>` with the implicit `main` role, so `screen.getByRole('main')` resolves correctly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend -- App.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/test/App.test.tsx
git commit -m "feat: add sidebar icons and light gray content background"
```

---

### Task 6: Table redesign — filter card, badges, sticky/zebra table, row actions

**Files:**
- Modify: `frontend/src/pages/TenderListPage.tsx`
- Modify: `frontend/src/test/TenderListPage.test.tsx`

**Interfaces:**
- Consumes: `Badge` (Task 2), `DaysLeftBadge` (Task 3).
- Produces: nothing new consumed by Task 7 (Task 7 adds a sibling prop/section to the same file).

- [ ] **Step 1: Write the failing tests**

Replace these three existing tests in `frontend/src/test/TenderListPage.test.tsx` (they currently assert plain-text Source and Type rendering, which the redesign changes to badges):

```tsx
  it('renders tender rows without Price/Status columns, with Field Code and Source columns', async () => {
    renderList(<TenderListPage status="open" />);
    expect(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).toBeInTheDocument();
    expect(screen.getByText('UTHM/54/P/02/023/2026')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^price/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^status/i })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /field code/i })).toBeInTheDocument();
    expect(screen.getByText('060501')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^source/i })).toBeInTheDocument();
    const row = (await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).closest('tr')!;
    expect(within(row).getByText('myprocurement')).toBeInTheDocument();
  });

  it('joins multiple sources as separate badges in the Source column', async () => {
    server.use(http.get('/api/tenders', () => HttpResponse.json({
      items: [makeTender({
        sources: [
          { source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1' },
          { source: 'span', sourceId: '9', sourceUrl: 'https://example.com/9' },
        ],
      })],
      total: 1, page: 1, pageSize: 20,
    })));
    renderList(<TenderListPage status="open" />);
    const row = (await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).closest('tr')!;
    expect(within(row).getByText('myprocurement')).toBeInTheDocument();
    expect(within(row).getByText('span')).toBeInTheDocument();
  });
```

Add these new tests to the same `describe('TenderListPage', ...)` block:

```tsx
  it('shows the Type value as a colored badge', async () => {
    renderList(<TenderListPage status="open" />);
    const row = (await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).closest('tr')!;
    expect(within(row).getByText('quotation')).toHaveClass('bg-blue-100');
  });

  it('shows a days-left indicator next to the closing date', async () => {
    renderList(<TenderListPage status="open" />);
    const row = (await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).closest('tr')!;
    expect(within(row).getByTestId('days-left')).toHaveTextContent(/d left|today|overdue/i);
  });

  it('wraps the search and filter controls in one card container', async () => {
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    const card = screen.getByTestId('filter-card');
    expect(card).toContainElement(screen.getByPlaceholderText(/search/i));
    expect(card).toContainElement(screen.getByLabelText(/ministry/i));
  });

  it('renders View, Save, and Share action buttons per row without triggering row navigation for Save/Share', async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    renderList(<TenderListPage status="open" />);
    const row = (await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).closest('tr')!;

    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));
    expect(within(row).getByRole('button', { name: 'Save' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('DETAIL PAGE')).not.toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: 'Share' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/tenders/UTHM%2F54%2FP%2F02%2F023%2F2026'));
    expect(screen.queryByText('DETAIL PAGE')).not.toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: 'View' }));
    expect(await screen.findByText('DETAIL PAGE')).toBeInTheDocument();
  });
```

Add `vi` to the vitest import at the top of the file: `import { describe, expect, it, vi } from 'vitest';`

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- TenderListPage.test.tsx`
Expected: FAIL — badge classes, `data-testid="days-left"`, `data-testid="filter-card"`, and the View/Save/Share buttons don't exist yet

- [ ] **Step 3: Write minimal implementation**

Replace the full contents of `frontend/src/pages/TenderListPage.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Tender } from '../api/types';
import { fetchFacets, fetchTenders } from '../api/client';
import Badge from '../components/Badge';
import DaysLeftBadge from '../components/DaysLeftBadge';
import FieldCodeFilter from '../components/FieldCodeFilter';
import { formatDate } from '../lib/format';

type SortBy = 'advertisedDate' | 'closingDate' | 'indicativePrice';

const FILTERS = [
  { key: 'ministry', label: 'Ministry', facet: 'ministries' },
  { key: 'agency', label: 'Agency', facet: 'agencies' },
  { key: 'category', label: 'Category', facet: 'categories' },
  { key: 'source', label: 'Source', facet: 'sources' },
  { key: 'procurementType', label: 'Type', facet: 'procurementTypes' },
] as const;

function formatContractors(winners: Tender['winners']): string {
  if (!winners || winners.length === 0) return '—';
  return winners.map((w) => w.name).join(', ');
}

function formatPricesWon(winners: Tender['winners']): string {
  if (!winners || winners.length === 0) return '—';
  return winners
    .map((w) => (w.price === null ? 'RM —' : `RM ${w.price.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`))
    .join(', ');
}

interface Props {
  status: 'open' | 'closed';
  hasWinners?: boolean;
}

export default function TenderListPage({ status, hasWinners = false }: Props) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(searchParams.get('search') ?? '');
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const [contractorInput, setContractorInput] = useState(searchParams.get('contractor') ?? '');
  const [contractor, setContractor] = useState(searchParams.get('contractor') ?? '');
  const [filters, setFilters] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const f of FILTERS) {
      const v = searchParams.get(f.key);
      if (v) initial[f.key] = v;
    }
    return initial;
  });
  const [fieldCode, setFieldCode] = useState(searchParams.get('fieldCode') ?? '');
  const [closingFrom, setClosingFrom] = useState(searchParams.get('closingFrom') ?? '');
  const [closingTo, setClosingTo] = useState(searchParams.get('closingTo') ?? '');
  const [sortBy, setSortBy] = useState<SortBy>((searchParams.get('sortBy') as SortBy) ?? 'advertisedDate');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(
    (searchParams.get('sortOrder') as 'asc' | 'desc') ?? 'desc',
  );
  const [page, setPage] = useState(Number(searchParams.get('page') ?? '1'));
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    const h = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
    return () => clearTimeout(h);
  }, [searchInput]);

  useEffect(() => {
    const h = setTimeout(() => { setContractor(contractorInput); setPage(1); }, 300);
    return () => clearTimeout(h);
  }, [contractorInput]);

  useEffect(() => {
    const next: Record<string, string> = {
      ...(search ? { search } : {}),
      ...(hasWinners && contractor ? { contractor } : {}),
      ...(fieldCode ? { fieldCode } : {}),
      ...(closingFrom ? { closingFrom } : {}),
      ...(closingTo ? { closingTo } : {}),
      ...(sortBy !== 'advertisedDate' ? { sortBy } : {}),
      ...(sortOrder !== 'desc' ? { sortOrder } : {}),
      ...(page !== 1 ? { page: String(page) } : {}),
      ...filters,
    };
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, contractor, fieldCode, closingFrom, closingTo, sortBy, sortOrder, page, filters, hasWinners]);

  const params: Record<string, string> = {
    search, status, sortBy, sortOrder, page: String(page),
    ...(hasWinners ? { hasWinners: 'true' } : {}),
    ...(hasWinners && contractor ? { contractor } : {}),
    ...(fieldCode ? { fieldCode } : {}),
    ...(closingFrom ? { closingFrom } : {}),
    ...(closingTo ? { closingTo } : {}),
    ...filters,
  };
  const { data: pageData } = useQuery({
    queryKey: ['tenders', params],
    queryFn: () => fetchTenders(params),
  });
  const { data: facets } = useQuery({ queryKey: ['facets'], queryFn: fetchFacets });

  const toggleSort = (col: SortBy) => {
    if (sortBy === col) setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortOrder('desc'); }
    setPage(1);
  };
  const sortIndicator = (col: SortBy) => (sortBy === col ? (sortOrder === 'asc' ? ' ▲' : ' ▼') : '');
  const totalPages = pageData ? Math.max(1, Math.ceil(pageData.total / pageData.pageSize)) : 1;

  function toggleSave(key: string) {
    setSavedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function shareLink(referenceNo: string) {
    navigator.clipboard.writeText(`${window.location.origin}/tenders/${encodeURIComponent(referenceNo)}`);
  }

  return (
    <div className="space-y-4">
      <div data-testid="filter-card" className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 space-y-4">
        <div className="flex flex-wrap gap-3 items-end">
          <input
            type="search"
            placeholder="Search title or reference no…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="border border-[#e0e0e0] rounded-md px-3 py-2 w-72 text-[10px]"
          />
          {hasWinners && (
            <label className="flex flex-col text-[10px] gap-1">
              Contractor
              <input
                type="text"
                placeholder="Search contractor…"
                className="border border-[#e0e0e0] rounded-md px-2 py-2 w-40 text-[10px]"
                value={contractorInput}
                onChange={(e) => setContractorInput(e.target.value)}
              />
            </label>
          )}
        </div>

        <div className="flex flex-wrap gap-3 items-end">
          {FILTERS.map((f) => (
            <label key={f.key} className="flex flex-col text-[10px] gap-1">
              {f.label}
              <select
                className="border border-[#e0e0e0] rounded-md px-2 py-2 w-40 truncate text-[10px]"
                title={filters[f.key] || undefined}
                value={filters[f.key] ?? ''}
                onChange={(e) => {
                  setFilters((prev) => ({ ...prev, [f.key]: e.target.value }));
                  setPage(1);
                }}
              >
                <option value="">All</option>
                {(facets?.[f.facet] ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          ))}
          <FieldCodeFilter value={fieldCode} onChange={(c) => { setFieldCode(c); setPage(1); }} />
          <label className="flex flex-col text-[10px] gap-1">
            Closing from
            <input
              type="date"
              className="border border-[#e0e0e0] rounded-md px-2 py-2 text-[10px]"
              value={closingFrom}
              onChange={(e) => { setClosingFrom(e.target.value); setPage(1); }}
            />
          </label>
          <label className="flex flex-col text-[10px] gap-1">
            Closing to
            <input
              type="date"
              className="border border-[#e0e0e0] rounded-md px-2 py-2 text-[10px]"
              value={closingTo}
              onChange={(e) => { setClosingTo(e.target.value); setPage(1); }}
            />
          </label>
        </div>
      </div>

      <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white shadow-sm">
        <table className="data-table w-full text-[10px]">
          <thead className="bg-gray-100 text-left sticky top-0 z-10">
            <tr>
              <th className="px-3 py-3 uppercase tracking-wide w-full">Title</th>
              <th className="px-3 py-3 uppercase tracking-wide">Reference No</th>
              {!hasWinners && <th className="px-3 py-3 uppercase tracking-wide">Ministry</th>}
              {!hasWinners && <th className="px-3 py-3 uppercase tracking-wide">Type</th>}
              <th className="px-3 py-3 uppercase tracking-wide">
                <button onClick={() => toggleSort('closingDate')}>Closing Date{sortIndicator('closingDate')}</button>
              </th>
              <th className="px-3 py-3 uppercase tracking-wide">Field Code</th>
              <th className="px-3 py-3 uppercase tracking-wide">Source</th>
              {hasWinners && <th className="px-3 py-3 uppercase tracking-wide">Contractor</th>}
              {hasWinners && <th className="px-3 py-3 uppercase tracking-wide">Price Won</th>}
              <th className="px-3 py-3 uppercase tracking-wide">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(pageData?.items ?? []).map((t, i) => (
              <tr
                key={t.dedupKey}
                onClick={() => navigate(`/tenders/${encodeURIComponent(t.referenceNo)}`)}
                className={`cursor-pointer hover:bg-blue-50 ${i % 2 === 1 ? 'bg-gray-50/50' : ''}`}
              >
                <td className="px-3 py-3 font-medium">{t.title}</td>
                <td className="px-3 py-3">
                  <div className="w-28 break-all">{t.referenceNo}</div>
                </td>
                {!hasWinners && <td className="px-3 py-3">{t.ministry ?? '—'}</td>}
                {!hasWinners && (
                  <td className="px-3 py-3">
                    {t.procurementType === null ? '—' : <Badge label={t.procurementType} />}
                  </td>
                )}
                <td className="px-3 py-3 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <span>{formatDate(t.closingDate) ?? '—'}</span>
                    <DaysLeftBadge closingDate={t.closingDate} />
                  </div>
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  {t.fieldCodes.length === 0
                    ? '—'
                    : <Badge label={t.fieldCodes.length === 1 ? t.fieldCodes[0] : `${t.fieldCodes[0]} +${t.fieldCodes.length - 1}`} colorKey={t.fieldCodes[0]} />}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  <div className="flex gap-1">
                    {t.sources.map((s) => <Badge key={s.source} label={s.source} />)}
                  </div>
                </td>
                {hasWinners && <td className="px-3 py-3">{formatContractors(t.winners)}</td>}
                {hasWinners && <td className="px-3 py-3 whitespace-nowrap">{formatPricesWon(t.winners)}</td>}
                <td className="px-3 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="text-[10px] text-blue-700 underline"
                      onClick={() => navigate(`/tenders/${encodeURIComponent(t.referenceNo)}`)}
                    >
                      View
                    </button>
                    <button
                      type="button"
                      aria-pressed={savedKeys.has(t.dedupKey)}
                      className={`text-[10px] underline ${savedKeys.has(t.dedupKey) ? 'text-amber-600' : 'text-gray-500'}`}
                      onClick={() => toggleSave(t.dedupKey)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="text-[10px] text-gray-500 underline"
                      onClick={() => shareLink(t.referenceNo)}
                    >
                      Share
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-4">
        <span className="text-xs">{pageData?.total ?? 0} tenders</span>
        <button
          className="border rounded-md px-3 py-1 text-sm disabled:opacity-50"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous
        </button>
        <span className="text-xs">Page {page} of {totalPages}</span>
        <button
          className="border rounded-md px-3 py-1 text-sm disabled:opacity-50"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
```

Note: the `renders "—" for a null procurementType` test already in the file asserts `within(row).getByText('—')` — this still passes since the Type cell renders plain `'—'` text (not a `Badge`) when `procurementType` is `null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend -- TenderListPage.test.tsx`
Expected: PASS (all tests, including the new ones)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/TenderListPage.tsx frontend/src/test/TenderListPage.test.tsx
git commit -m "feat: redesign tender table with badges, days-left, sticky header, and row actions"
```

---

### Task 7: Open Tenders page header and stat cards

**Files:**
- Modify: `frontend/src/pages/TenderListPage.tsx`
- Modify: `frontend/src/test/TenderListPage.test.tsx`

**Interfaces:**
- Consumes: `StatCard` (Task 4), `todayISO`/`addDaysISO` (Task 1), `fetchDashboard` (`frontend/src/api/client.ts`, existing), new `showHeader?: boolean` prop.
- Produces: nothing (leaf task).

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/test/TenderListPage.test.tsx`:

```tsx
  describe('showHeader (Open Tenders page)', () => {
    it('renders the page title and description', async () => {
      renderList(<TenderListPage status="open" showHeader />);
      expect(await screen.findByRole('heading', { name: 'Open Tenders' })).toBeInTheDocument();
      expect(screen.getByText(/browse and filter/i)).toBeInTheDocument();
    });

    it('shows 4 stat cards with counts from the tenders and dashboard endpoints', async () => {
      server.use(http.get('/api/tenders', ({ request }) => {
        const url = new URL(request.url);
        const closingFrom = url.searchParams.get('closingFrom');
        const closingTo = url.searchParams.get('closingTo');
        if (closingFrom && closingFrom === closingTo) {
          return HttpResponse.json({ items: [], total: 3, page: 1, pageSize: 1 });
        }
        if (closingFrom) {
          return HttpResponse.json({ items: [], total: 12, page: 1, pageSize: 1 });
        }
        return HttpResponse.json({ ...defaultPage, total: 128 });
      }));
      renderList(<TenderListPage status="open" showHeader />);
      expect(await screen.findByText('Open Tenders')).toBeInTheDocument();
      expect(await screen.findByText('128')).toBeInTheDocument();
      expect(await screen.findByText('Closing Today')).toBeInTheDocument();
      expect(await screen.findByText('3')).toBeInTheDocument();
      expect(await screen.findByText('Closing This Week')).toBeInTheDocument();
      expect(await screen.findByText('12')).toBeInTheDocument();
      expect(await screen.findByText('Awarded')).toBeInTheDocument();
      expect(await screen.findByText('42')).toBeInTheDocument();
    });

    it('does not render the header or stat cards when showHeader is not set', async () => {
      renderList(<TenderListPage status="closed" hasWinners />);
      await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
      expect(screen.queryByRole('heading', { name: 'Open Tenders' })).not.toBeInTheDocument();
      expect(screen.queryByText('Closing Today')).not.toBeInTheDocument();
    });
  });
```

This relies on `defaultDashboardStats.totalAwardedCount` being `42` (already defined in `frontend/src/test/mocks.ts`) and the existing `/api/dashboard` mock handler.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- TenderListPage.test.tsx`
Expected: FAIL — no `showHeader` prop, no page title, no stat cards

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/pages/TenderListPage.tsx`:

Add imports:

```tsx
import { fetchDashboard, fetchFacets, fetchTenders } from '../api/client';
import StatCard from '../components/StatCard';
import { addDaysISO, todayISO } from '../lib/dateRange';
```

(Replace the existing `import { fetchFacets, fetchTenders } from '../api/client';` line with the merged import above.)

Update the `Props` interface:

```tsx
interface Props {
  status: 'open' | 'closed';
  hasWinners?: boolean;
  showHeader?: boolean;
}
```

Update the function signature:

```tsx
export default function TenderListPage({ status, hasWinners = false, showHeader = false }: Props) {
```

Add these queries right after the existing `facets` query:

```tsx
  const today = todayISO();
  const weekEnd = addDaysISO(today, 7);
  const { data: openCount } = useQuery({
    queryKey: ['tenders-count', 'open'],
    queryFn: () => fetchTenders({ status: 'open', pageSize: '1' }),
    enabled: showHeader,
  });
  const { data: closingTodayCount } = useQuery({
    queryKey: ['tenders-count', 'closingToday', today],
    queryFn: () => fetchTenders({ status: 'open', closingFrom: today, closingTo: today, pageSize: '1' }),
    enabled: showHeader,
  });
  const { data: closingWeekCount } = useQuery({
    queryKey: ['tenders-count', 'closingWeek', today, weekEnd],
    queryFn: () => fetchTenders({ status: 'open', closingFrom: today, closingTo: weekEnd, pageSize: '1' }),
    enabled: showHeader,
  });
  const { data: dashboardStats } = useQuery({
    queryKey: ['dashboard'],
    queryFn: fetchDashboard,
    enabled: showHeader,
  });
```

Add the header + stat cards as the first children inside the outer `<div className="space-y-4">`, immediately before the `filter-card` div:

```tsx
      {showHeader && (
        <>
          <div>
            <h1 className="text-lg font-semibold">Open Tenders</h1>
            <p className="text-xs text-gray-500 mt-1">
              Browse and filter tenders that are currently open for bidding.
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label="Open Tenders" value={openCount?.total ?? '—'} />
            <StatCard label="Closing Today" value={closingTodayCount?.total ?? '—'} />
            <StatCard label="Closing This Week" value={closingWeekCount?.total ?? '—'} />
            <StatCard label="Awarded" value={dashboardStats?.totalAwardedCount ?? '—'} />
          </div>
        </>
      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend -- TenderListPage.test.tsx`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full frontend suite and the full monorepo suite**

Run: `npm test -w frontend`
Expected: all frontend test files pass

Run: `npm test`
Expected: all workspaces (shared, backend, frontend) pass

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/TenderListPage.tsx frontend/src/test/TenderListPage.test.tsx
git commit -m "feat: add Open Tenders page header and stat cards"
```

---

### Task 8: Live verification

Not a code task — verify the redesign live in the browser per the project's `e2e-playwright-verification` skill before considering the plan complete.

- [ ] **Step 1:** Start the backend (`npm run dev -w backend`, or a temporary alternate port per this session's established workaround if 3001 is occupied) and the frontend (`npm run dev -w frontend`).
- [ ] **Step 2:** Navigate to `/open` — confirm the page header, 4 stat cards, filter card, sticky/zebra table, badges, days-left indicators, and row action buttons all render correctly with real data.
- [ ] **Step 3:** Navigate to `/closed` and `/awarded` — confirm no header/stat cards appear there, but the table redesign (badges, sticky header, row actions) is present.
- [ ] **Step 4:** Click Save and Share on a row — confirm Save toggles visually and doesn't navigate; confirm Share doesn't navigate (clipboard write can't be verified in this environment but the click must not trigger row navigation).
- [ ] **Step 5:** Check `read_console_messages` for errors.
- [ ] **Step 6:** Revert any temporary dev-server config changes made for verification (e.g. `vite.config.ts` proxy target, as done in prior sessions).
