# Filter Tenders by Data Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users filter the tender list down to a single data source (`myprocurement`, `span`, `kwsp`), and show each tender's source(s) as a column in the list — following the codebase's existing generic filter/facet pattern exactly.

**Architecture:** Backend: one new equality-ish filter (`source`, matched against any entry in a tender's `sources` array) and one new facet (`sources`, distinct values actually present in the data), added to the existing `queryTenders`/`buildFacets` functions and the `QuerySchema` Zod validator — no new endpoints. Frontend: one new entry in the existing `FILTERS` array (which already drives dropdown rendering, query params, and refetching generically) plus one new table column.

**Tech Stack:** TypeScript (ESM), Express backend, React + Vite frontend, `zod`, `vitest` + `@testing-library/react` + `msw`.

## Global Constraints

- Write the failing test first, run it, confirm it fails for the right reason, then implement, then run again to confirm it passes. Never commit red.
- Commit immediately after each task goes green.
- Coverage thresholds (80% lines/branches) are enforced by vitest; don't lower them.
- Filtering by source means "this tender has at least one record from this source" (`t.sources.some((s) => s.source === q.source)`), not "this is its only source" — a tender can be merged from multiple sources.
- Facet values are derived from the data itself (distinct `sources[].source` values actually present), not hardcoded to the three known adapter names.
- `frontend/src/test/TenderListPage.test.tsx` has a pre-existing test that explicitly asserts no Source column exists ("renders tender rows without Source/Price/Status columns..."). That assertion must be updated as part of this work, not left contradicting the new behavior.

Design reference: [`docs/superpowers/specs/2026-07-11-source-filter-design.md`](../specs/2026-07-11-source-filter-design.md)

---

### Task 1: Backend — source filter and facet

**Files:**
- Modify: `backend/src/query/tenders.ts`
- Modify: `backend/src/api/app.ts`
- Test: `backend/test/query.test.ts`

**Interfaces:**
- Consumes: existing `Tender` type from `@tms/shared` (already has `sources: TenderSource[]`, unchanged by this task).
- Produces: `TenderQuery.source?: string`, `Facets.sources: string[]` — consumed by Task 2 (frontend) via the JSON shape of `/api/tenders` and `/api/tenders/facets`, which Task 2 reads through `frontend/src/api/types.ts`'s (separately maintained, structurally identical) `Facets` type.

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/query.test.ts`, inside `describe('queryTenders', ...)` (place after the existing `'filters by contractor name...'` test, before `'sorts by price desc...'`):

```ts
  it('filters by source, matching a tender that has the source among possibly several', () => {
    const data = [
      t({ sources: [{ source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1' }] }),
      t({ sources: [
        { source: 'myprocurement', sourceId: '2', sourceUrl: 'https://example.com/2' },
        { source: 'span', sourceId: '9', sourceUrl: 'https://example.com/9' },
      ] }),
      t({ sources: [{ source: 'kwsp', sourceId: 'Doc1', sourceUrl: 'https://example.com/kwsp/1' }] }),
    ];
    expect(queryTenders(data, { source: 'span' }).total).toBe(1);
    expect(queryTenders(data, { source: 'myprocurement' }).total).toBe(2);
    expect(queryTenders(data, { source: 'kwsp' }).total).toBe(1);
    expect(queryTenders(data, { source: 'nonexistent' }).total).toBe(0);
  });
```

Add to `describe('buildFacets', ...)`, replacing the existing single test with (the only change is the added `sources` override on two records and the added `f.sources` assertion — everything else in the test is unchanged):

```ts
  it('returns sorted distinct values, omitting nulls, including fieldCodes and sources', () => {
    const data = [
      t({
        ministry: 'Z', agency: null, category: 'Kerja', procurementType: 'tender', fieldCodes: ['220801', '010101'],
        sources: [{ source: 'span', sourceId: '1', sourceUrl: 'https://example.com/1' }],
      }),
      t({ ministry: 'A', fieldCodes: ['010101'] }),
      t({ ministry: 'A' }),
    ];
    const f = buildFacets(data);
    expect(f.ministries).toEqual(['A', 'Z']);
    expect(f.agencies).toEqual(['AGENSI A']);
    expect(f.procurementTypes).toEqual(['quotation', 'tender']);
    expect(f.fieldCodes).toEqual(['010101', '220801']);
    expect(f.sources).toEqual(['myprocurement', 'span']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run test/query.test.ts`
Expected: FAIL — `queryTenders`/`buildFacets` don't accept/return a `source`/`sources` field yet (TypeScript won't block this at test-run time since vitest doesn't type-check, but the `source` filter will be silently ignored so `total` won't match, and `f.sources` will be `undefined`, not `['myprocurement', 'span']`).

- [ ] **Step 3: Implement the filter and facet**

In `backend/src/query/tenders.ts`, update `TenderQuery` (add one field after `category`):

```ts
export interface TenderQuery {
  search?: string;
  ministry?: string;
  agency?: string;
  category?: string;
  source?: string;
  status?: 'open' | 'closed';
  procurementType?: 'quotation' | 'tender' | 'requisition';
  fieldCode?: string;
  hasWinners?: boolean;
  contractor?: string;
  sortBy?: 'advertisedDate' | 'closingDate' | 'indicativePrice';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}
```

Update `Facets` (add one field after `categories`):

```ts
export interface Facets {
  ministries: string[];
  agencies: string[];
  categories: string[];
  sources: string[];
  procurementTypes: string[];
  fieldCodes: string[];
}
```

In `queryTenders`, add one line after the existing `if (q.category) items = items.filter((t) => t.category === q.category);` line:

```ts
  if (q.source) items = items.filter((t) => t.sources.some((s) => s.source === q.source));
```

In `buildFacets`, add one line after the existing `categories: distinct(tenders.map((t) => t.category)),` line:

```ts
    sources: distinct(tenders.flatMap((t) => t.sources.map((s) => s.source))),
```

In `backend/src/api/app.ts`, add one line to `QuerySchema` after the existing `category: z.string().optional(),` line:

```ts
  source: z.string().optional(),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run test/query.test.ts`
Expected: PASS (all tests in the file, including the two changed/added above).

- [ ] **Step 5: Run the full backend suite to confirm no regressions, then commit**

Run: `cd backend && npx vitest run`
Expected: PASS (all files, including `test/app.test.ts`, which exercises `QuerySchema` end-to-end and must still pass unchanged since `source` is optional and additive).

```bash
git add backend/src/query/tenders.ts backend/src/api/app.ts backend/test/query.test.ts
git commit -m "feat(backend): add source filter and facet for tender queries"
```

---

### Task 2: Frontend — Source filter dropdown and table column

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/pages/TenderListPage.tsx`
- Modify: `frontend/src/test/mocks.ts`
- Test: `frontend/src/test/TenderListPage.test.tsx`

**Interfaces:**
- Consumes: `Facets.sources: string[]` and `Tender.sources: TenderSource[]` (the latter already exists, unchanged) from `frontend/src/api/types.ts`; the backend shape from Task 1.
- Produces: no new exports — this task only changes UI rendering and the shared test fixtures other frontend tests also import from `frontend/src/test/mocks.ts`.

- [ ] **Step 1: Update shared types and test fixtures**

In `frontend/src/api/types.ts`, update the `Facets` interface:

```ts
export interface Facets {
  ministries: string[]; agencies: string[]; categories: string[]; sources: string[];
  procurementTypes: string[]; fieldCodes: string[];
}
```

In `frontend/src/test/mocks.ts`, update `defaultFacets` to include `sources` (needed so the Source dropdown has options to select from in tests):

```ts
export const defaultFacets: Facets = {
  ministries: ['KEMENTERIAN PENDIDIKAN TINGGI'], agencies: ['UTHM'],
  categories: ['Perkhidmatan Bukan Perunding'], sources: ['myprocurement', 'span'],
  procurementTypes: ['quotation'],
  fieldCodes: ['060501'],
};
```

- [ ] **Step 2: Write the failing tests**

In `frontend/src/test/TenderListPage.test.tsx`, replace the existing first test (currently titled `'renders tender rows without Source/Price/Status columns, with a Field Code column'`) with:

```ts
  it('renders tender rows without Price/Status columns, with Field Code and Source columns', async () => {
    renderList(<TenderListPage status="open" />);
    expect(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).toBeInTheDocument();
    expect(screen.getByText('UTHM/54/P/02/023/2026')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^price/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^status/i })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /field code/i })).toBeInTheDocument();
    expect(screen.getByText('060501')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^source/i })).toBeInTheDocument();
    expect(screen.getByText('myprocurement')).toBeInTheDocument();
  });
```

Add a new test right after the existing `'populates filter dropdowns from facets and refetches on change'` test:

```ts
  it('populates the Source filter from facets and sends source as a query param on change', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    await userEvent.selectOptions(await screen.findByLabelText(/^source/i), 'span');
    await waitFor(() => expect(requests.some((u) => u.includes('source=span'))).toBe(true));
  });
```

Add a test proving a tender merged from multiple sources shows all of them, right after the "renders tender rows without Price/Status columns..." test:

```ts
  it('joins multiple sources with a comma in the Source column', async () => {
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
    expect(await screen.findByText('myprocurement, span')).toBeInTheDocument();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/test/TenderListPage.test.tsx`
Expected: FAIL — no "Source" column/filter exists yet, so the column-header and dropdown queries find nothing, and `source=span` never appears in a request URL.

- [ ] **Step 4: Implement the filter and column**

In `frontend/src/pages/TenderListPage.tsx`, update the `FILTERS` constant:

```ts
const FILTERS = [
  { key: 'ministry', label: 'Ministry', facet: 'ministries' },
  { key: 'agency', label: 'Agency', facet: 'agencies' },
  { key: 'category', label: 'Category', facet: 'categories' },
  { key: 'source', label: 'Source', facet: 'sources' },
  { key: 'procurementType', label: 'Type', facet: 'procurementTypes' },
] as const;
```

Add a "Source" column header, right after the existing Field Code `<th>` and before the `hasWinners &&` conditional headers:

```tsx
              <th className="px-3 py-2 uppercase tracking-wide">Field Code</th>
              <th className="px-3 py-2 uppercase tracking-wide">Source</th>
              {hasWinners && <th className="px-3 py-2 uppercase tracking-wide">Contractor</th>}
```

Add the matching cell, right after the existing Field Code `<td>` and before the `hasWinners &&` conditional cells:

```tsx
                <td className="px-3 py-2 whitespace-nowrap">
                  {t.fieldCodes.length === 0
                    ? '—'
                    : t.fieldCodes.length === 1
                      ? t.fieldCodes[0]
                      : `${t.fieldCodes[0]} +${t.fieldCodes.length - 1}`}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{t.sources.map((s) => s.source).join(', ')}</td>
                {hasWinners && <td className="px-3 py-2">{formatContractors(t.winners)}</td>}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/test/TenderListPage.test.tsx`
Expected: PASS (all tests in the file, including the new/updated ones above).

- [ ] **Step 6: Run the full frontend suite to confirm no regressions, then commit**

Run: `cd frontend && npx vitest run`
Expected: PASS (all files — the `defaultFacets` change in `mocks.ts` is additive so other tests that import it, e.g. any dashboard/settings page tests, should be unaffected; confirm this by checking the full run is green, not just this file).

```bash
git add frontend/src/api/types.ts frontend/src/pages/TenderListPage.tsx frontend/src/test/mocks.ts frontend/src/test/TenderListPage.test.tsx
git commit -m "feat(frontend): add Source filter dropdown and table column"
```

---

## Final verification

- [ ] **Run the full workspace test suite**

Run (from repo root): `npm test`
Expected: All workspaces (`shared`, `backend`, `frontend`) pass, coverage thresholds met.
