# Dashboard Analytics Page — Design

**Date:** 2026-07-10
**Status:** Approved by user

## Purpose

Add a Dashboard page that answers, at a glance, three questions about awarded tenders:
which ministries spend the most, which contractors win the most, and how awarded value
has trended year over year. This is the first analytics surface in the app — everything
else so far is a searchable list.

## Definition of "awarded"

Same rule the existing "Awarded Tenders" nav tab already uses (`frontend/src/App.tsx`,
`TenderListPage status="closed" hasWinners`): a tender is awarded if
`status === 'closed'` and `winners` is a non-empty array. No new concept — the dashboard
just aggregates over this existing subset instead of listing it.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Widgets | Headline totals, top 10 ministries by spend, top 10 contractors by win count, awarded value per year. Nothing else in this iteration (no procurement-type or per-source breakdown). |
| Missing winner price | A tender/winner with no recorded price still counts toward every *count* (total awarded tenders, ministry's award count, contractor's win count), but is excluded from every *money* total. The page shows a caption stating how many awards were excluded from the money totals for this reason. |
| Charting | Plain CSS bars (div width/height as a percentage), no charting library — consistent with the app's existing minimal-dependency Tailwind styling. |
| Ranking size | Top 10 for both ministries and contractors. |
| Trend granularity | Per year, total awarded value (not count). |
| Filters | None — a single all-time snapshot. No year/ministry filter controls in this iteration. |
| Nav placement | New "Dashboard" link, first in the left nav (before Open/Closed/Awarded Tenders), route `/dashboard`. |

## Attribution rules

- **Multiple winners per tender:** a tender's `winners` array can have more than one entry
  (joint awards). Each winner is attributed independently: their own `price` (if not null)
  adds to their own contractor total and to that tender's ministry total. A tender with
  winners `[{name: A, price: 100}, {name: B, price: null}]` contributes 100 to A's total,
  nothing to B's total (excluded, but B's win count still increments by 1), and 100 to the
  ministry's total.
- **Which year a tender counts toward:** `closingDate ?? advertisedDate`, sliced to its
  year. If both are null, the tender is counted in every non-time-bucketed total (headline,
  ministry, contractor) but skipped from the by-year trend entirely (there's no year to
  place it in).
- **Null ministry:** grouped under the literal label `"Unknown"` rather than dropped, so
  the award count stays consistent with the headline total. (In practice this bucket will
  rarely rank in the top 10 by spend, since a missing ministry commonly correlates with
  other missing fields, but it is never silently discarded.)

## Backend

### New pure aggregation function

**File:** `backend/src/query/dashboard.ts` (new, alongside the existing `tenders.ts` in
the same directory)

```ts
import type { Tender } from '@tms/shared';

export interface MinistryStat {
  ministry: string; // "Unknown" for null
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
  excludedFromValueCount: number; // number of (tender, winner) pairs with a null price
  byMinistry: MinistryStat[]; // top 10 by totalValue desc
  topContractors: ContractorStat[]; // top 10 by wins desc, ties broken by totalValue desc
  byYear: YearStat[]; // every year that has at least one awarded tender, ascending
}

export function buildDashboardStats(tenders: Tender[]): DashboardStats {
  // implementation: filter to awarded tenders, then single pass accumulating into
  // Map<string, MinistryStat>, Map<string, ContractorStat>, Map<number, YearStat>,
  // plus the two headline running totals and excludedFromValueCount. Sort each map's
  // values per the rules above before returning.
}
```

This is a pure function over `Tender[]` (same shape as `buildFacets`/`queryTenders` in
`backend/src/query/tenders.ts`), so it is unit-testable with plain fixture arrays and
takes no dependency on the repository or Express.

### New endpoint

**File:** `backend/src/api/app.ts`

```ts
app.get('/api/dashboard', (_req, res) => {
  res.json(buildDashboardStats(deps.repo.getAll()));
});
```

No query parameters (matches the "no filters" decision). No new request schema needed.

## Frontend

### New types and API client function

**File:** `frontend/src/api/types.ts` — add `MinistryStat`, `ContractorStat`, `YearStat`,
`DashboardStats`, mirroring the backend interfaces exactly (same field names/types).

**File:** `frontend/src/api/client.ts` — add:
```ts
export async function fetchDashboard(): Promise<DashboardStats> {
  const res = await fetch('/api/dashboard');
  if (!res.ok) throw new Error('failed to fetch dashboard stats');
  return res.json();
}
```

### New page

**File:** `frontend/src/pages/DashboardPage.tsx` (new)

- Fetches via React Query: `useQuery({ queryKey: ['dashboard'], queryFn: fetchDashboard })`.
- Headline row: two stat tiles — "Total Awarded Value" (formatted as `RM` currency,
  e.g. `RM 12,345,678`) and "Total Awarded Tenders" (plain count) — plus a caption below
  them: `Excludes {excludedFromValueCount} awards with no recorded price` (only rendered
  when `excludedFromValueCount > 0`).
- "Spend by Ministry" section: `byMinistry` rendered as a horizontal bar list — each row
  is the ministry name, a bar (`<div>` with `style={{ width: '<pct>%' }}`, pct relative to
  the largest value in the list so the biggest spender's bar is full-width), the formatted
  value, and the count in parentheses.
- "Top Contractors" section: `topContractors` rendered the same bar-list way, bar width
  relative to the largest `wins` value in the list, showing wins count as the primary
  number and total value alongside.
- "Awarded Value by Year" section: `byYear` rendered as a bar per year (bar height/width
  relative to the largest year's value), x-axis label is the year, value shown above or
  alongside each bar. Years are already in ascending order from the backend.

- **Formatting:** a small shared helper `formatMYR(n: number): string` (e.g.
  `Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR', maximumFractionDigits: 0 })`)
  used by all three money displays; extracted into `frontend/src/lib/format.ts` (new) so it
  isn't duplicated three times across the page.

### Nav

**File:** `frontend/src/App.tsx`

Add `<NavLink to="/dashboard" className={navLinkClass}>Dashboard</NavLink>` as the first
entry in the top nav group (before "Open Tenders"), and `<Route path="/dashboard"
element={<DashboardPage />} />` in the routes.

## Testing / TDD

- `backend/test/dashboard.test.ts` (new): unit tests for `buildDashboardStats` covering —
  empty input; a single awarded tender with one priced winner; a joint award (two winners,
  one priced one not) splitting correctly; a null-ministry tender counted under
  `"Unknown"`; a tender with only `advertisedDate` (no `closingDate`) landing in the right
  year bucket; a tender with neither date excluded from `byYear` but still in the
  headline/ministry/contractor totals; more than 10 ministries/contractors to confirm
  top-10 truncation and sort order (value desc for ministries, wins desc for contractors);
  a tender that is `status: 'closed'` but has no winners (must not count as awarded); an
  `open` tender with winners present (must not count as awarded, matching the existing
  Awarded-tab rule).
- `backend/test/app.test.ts`: one new test asserting `GET /api/dashboard` returns the
  shape from `buildDashboardStats` (using a small fixture repo, following the existing
  pattern for other endpoint tests in this file).
- `frontend/src/test/DashboardPage.test.tsx` (new): renders headline stats, ministry and
  contractor bar lists with correct labels/values from a mocked `/api/dashboard` response,
  the "excludes N awards" caption appearing only when `excludedFromValueCount > 0`, and the
  year trend bars in ascending year order.
- `frontend/src/test/App.test.tsx`: update for the new "Dashboard" nav link and its route.
- `frontend/src/test/format.test.ts` (new): unit tests for `formatMYR`.

## Out of scope (this iteration)

- Filters (year, ministry, procurement type, data source).
- Procurement-type or per-source breakdowns.
- Any drill-down/click-through from a dashboard bar into the filtered tender list.
- Caching/memoizing the aggregation server-side (recomputed on every request, same as
  `buildFacets`/`queryTenders` already do over the full in-memory tender set).
