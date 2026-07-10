# Filter Tenders by Data Source — Design

**Date:** 2026-07-11
**Status:** Approved by user

## Purpose

With three data sources now merged into one tender store (MyProcurement, SPAN, KWSP), add a
way to narrow the tender list down to a single source, plus visibility into which source(s)
each listed tender came from (previously only shown on the detail page).

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Filter semantics | A tender can carry multiple `sources` entries (cross-source merge). Filtering by source means "has at least one record from this source" — `t.sources.some(s => s.source === q.source)` — not "this is its only source." |
| Facet values | Derived from the data itself (distinct `sources[].source` values actually present across all tenders), same convention as `ministries`/`agencies`/`categories`. Not hardcoded to the three known adapter names — grows automatically if a new source is added later. |
| List table | Add a "Source" column (previously source was only visible on the detail page). Multiple sources render comma-joined (e.g. `myprocurement, span`). |
| Existing test conflict | `frontend/src/test/TenderListPage.test.tsx` has a test titled "renders tender rows without Source/Price/Status columns" that explicitly asserts no Source column exists. This is a deliberate, expected change — that assertion must be updated, not left red. |

## Changes

### `backend/src/query/tenders.ts`
- `TenderQuery` gains `source?: string`.
- `queryTenders` gains: `if (q.source) items = items.filter((t) => t.sources.some((s) => s.source === q.source));`
- `Facets` gains `sources: string[]`.
- `buildFacets` gains: `sources: distinct(tenders.flatMap((t) => t.sources.map((s) => s.source)))` — reusing the file's existing `distinct` helper (it already accepts `Array<string | null>`; source names are never null, so this is a direct fit).

### `backend/src/api/app.ts`
- `QuerySchema` gains `source: z.string().optional()`.

### `frontend/src/api/types.ts`
- `Facets` gains `sources: string[]`, mirroring the backend type.

### `frontend/src/pages/TenderListPage.tsx`
- `FILTERS` gains `{ key: 'source', label: 'Source', facet: 'sources' }` — this single entry drives the dropdown, the query param, and the refetch through the existing generic filter-rendering loop; no bespoke UI code needed.
- Table gains a "Source" column between "Field Code" and the winners columns, rendering `t.sources.map((s) => s.source).join(', ')`.

## Testing

- `backend/test/query.test.ts`: a `source` filter case in the "filters by every supported field" test (or its own test, matching the file's existing granularity), and a `buildFacets` assertion for `sources`.
- `frontend/src/test/TenderListPage.test.tsx`:
  - Update "renders tender rows without Source/Price/Status columns, with a Field Code column" — remove the Source assertion from that "absent" list (title and remaining assertions change accordingly) and add a positive assertion that the Source column header and a source value render.
  - New test: selecting a value from the Source dropdown sends `source=...` and refetches, mirroring the existing "populates filter dropdowns from facets and refetches on change" test for Ministry.

## Out of scope

- Dashboard (`backend/src/query/dashboard.ts`) breakdowns by source — not requested.
- Any change to how sources are displayed on the detail page (already works).
