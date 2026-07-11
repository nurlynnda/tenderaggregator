# Filter Tenders by Closing Date — Design

**Date:** 2026-07-11
**Status:** Approved by user

## Purpose

Add a "filter by date" control to the tender list pages so users can narrow results to
tenders closing within a chosen date range. All three list routes — Open (`/open`),
Closed (`/closed`), Awarded (`/awarded`) — render the same `TenderListPage` component, so
one change covers all of them. The Dashboard and Detail pages are not lists and are out
of scope.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Date field | `closingDate` only (the submission deadline). `advertisedDate` and per-event dates are not filtered. |
| Range semantics | Two independent, optional, inclusive bounds: "Closing from" and "Closing to." Either may be set alone. A tender with `closingDate === null` is excluded once either bound is set (mirrors the existing nulls-last behavior in sorting, but here nulls are excluded rather than reordered, since a null date can't be judged "in range"). |
| Comparison | `closingDate` is stored as a plain `'YYYY-MM-DD'` string with no time component (confirmed in `backend/test/repository.test.ts`, `manager.test.ts`). Direct string comparison (`>=` / `<=`) is correct and needs no date parsing. |
| UI control | Two native `<input type="date">` fields, no new dependency. Matches the codebase's existing plain-HTML-control style; there is no date-picker library or component in the repo today. |
| Placement | Added to the existing filter row in `TenderListPage.tsx`, alongside the ministry/agency/category/source/type dropdowns. |
| Page reset | Changing either bound resets pagination to page 1, same as every other filter in this component. |
| Persistence | React state only, no URL query-string sync — matches how every other filter on this page already works (search, dropdowns, contractor, field code all reset on navigation). |

## Changes

### `backend/src/query/tenders.ts`
- `TenderQuery` gains `closingFrom?: string` and `closingTo?: string`.
- `queryTenders` gains, after the existing filters:
  ```ts
  if (q.closingFrom) items = items.filter((t) => t.closingDate !== null && t.closingDate >= q.closingFrom!);
  if (q.closingTo) items = items.filter((t) => t.closingDate !== null && t.closingDate <= q.closingTo!);
  ```

### `backend/src/api/app.ts`
- `QuerySchema` gains `closingFrom: z.string().optional()` and `closingTo: z.string().optional()`.
  No format validation beyond "is a string" — malformed dates simply compare oddly against
  the `YYYY-MM-DD` strings and yield no worse than an empty/mismatched result set, consistent
  with how other free-text filters (e.g. `ministry`) already behave with unexpected input.

### `frontend/src/pages/TenderListPage.tsx`
- Two new pieces of state: `closingFrom`, `closingTo` (plain `useState<string>('')`, no
  debounce needed since date inputs don't fire on every keystroke the way text search does).
- Both included in the `params` object passed to `fetchTenders`, following the same
  `...(value ? { key: value } : {})` spread pattern already used for `fieldCode`.
- Two `<input type="date">` elements added to the filter row, labeled "Closing from" and
  "Closing to," each calling `setPage(1)` on change (same pattern as the existing dropdown
  `onChange` handlers).

## Testing

Per the project's TDD rule, each item below is written as a failing test first, then the
minimal implementation follows.

- `backend/test/query.test.ts`:
  - `closingFrom` alone returns only tenders with `closingDate >= closingFrom`.
  - `closingTo` alone returns only tenders with `closingDate <= closingTo`.
  - Both set together returns only tenders within the inclusive range.
  - A tender with `closingDate: null` is excluded when either bound is set.
- `frontend/src/test/TenderListPage.test.tsx`:
  - New test: entering values in the "Closing from" / "Closing to" inputs sends
    `closingFrom` / `closingTo` as query params and refetches, mirroring the existing
    "populates filter dropdowns from facets and refetches on change" test.

## Out of scope

- Filtering by `advertisedDate` or event dates.
- Quick-preset buttons (e.g. "next 7 days") — plain from/to range only.
- URL query-string persistence for any filter, including this one.
- Dashboard (`backend/src/query/dashboard.ts`) date-range breakdowns.
