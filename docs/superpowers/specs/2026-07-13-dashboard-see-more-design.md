# Dashboard "See More" Detail Pages — Design

## Problem

The Dashboard's "Spend by Ministry" and "Top Contractors" sections only show the
top 10 entries (`buildDashboardStats` slices both lists to 10). There's no way
to see the full breakdown for ministries or contractors beyond the top 10.

## Goal

Add a "See more" link to each of those two sections that takes the user to a
dedicated page showing the complete, ranked list.

## Non-goals

- "Awarded Value by Year" is unaffected — it already shows every year with
  data, no truncation, so it gets no "See more" link.
- No sorting/searching UI on the detail pages — they're a longer version of
  the same ranked bar-list already used on the dashboard.
- No new API endpoint — the detail pages reuse data already fetched for the
  dashboard.

## Backend change

`backend/src/query/dashboard.ts`: `buildDashboardStats` already builds a full
`ministryMap` and `contractorMap` before slicing each to the top 10. Add two
new fields to `DashboardStats` carrying the complete, sorted lists:

```ts
export interface DashboardStats {
  totalAwardedValue: number;
  totalAwardedCount: number;
  excludedFromValueCount: number;
  byMinistry: MinistryStat[];       // existing: top 10 by totalValue
  topContractors: ContractorStat[]; // existing: top 10 by wins, then totalValue
  byYear: YearStat[];               // existing: all years
  allMinistries: MinistryStat[];    // new: all ministries by totalValue
  allContractors: ContractorStat[]; // new: all contractors by wins, then totalValue
}
```

Sort order for the new fields matches the existing top-10 sort (`allMinistries`
sorted by `totalValue` desc; `allContractors` sorted by `wins` desc then
`totalValue` desc) — just without the `.slice(0, 10)`.

`GET /api/dashboard` response grows these two fields; no route or param
changes.

## Frontend change

Two new routes registered in `App.tsx`:

- `/dashboard/ministries` → new `MinistryDetailPage` component
- `/dashboard/contractors` → new `ContractorDetailPage` component

Both pages call `useQuery({ queryKey: ['dashboard'], queryFn: fetchDashboard })`
— the same query key `DashboardPage` uses — so if the dashboard has already
been visited, the data is already in the React Query cache and the detail
page renders instantly with no loading spinner. (If a user deep-links
directly to `/dashboard/ministries` without visiting `/dashboard` first, the
query just fetches normally.)

Each detail page renders the full list using the same bar-list visual pattern
as the dashboard summary (label + value on top, proportional bar below,
scaled against the max value in the full list — not the top-10 max). Each
page has a "← Back to dashboard" link that calls `navigate(-1)`, consistent
with the pattern already used on `DetailPage.tsx` for tenders (returns to
wherever the user came from rather than a hardcoded path).

`DashboardPage.tsx` gets a small "See more →" link in the header row of the
"Spend by Ministry" and "Top Contractors" sections, linking to the
respective new route.

## Testing

- Backend: extend `dashboard.ts` unit tests to assert `allMinistries` and
  `allContractors` are present, unsliced (contain more than 10 entries when
  the fixture has more than 10), and correctly sorted.
- Frontend: new component tests for `MinistryDetailPage` and
  `ContractorDetailPage` (renders full list, back link navigates back).
  Existing `DashboardPage` tests extended to assert the "See more" links are
  present and point to the correct routes.
