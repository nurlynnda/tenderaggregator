# Closing Date Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Closing from" / "Closing to" date-range filter to the tender list pages
(Open, Closed, Awarded), filtering on the existing `closingDate` field.

**Architecture:** The filter follows the codebase's established query-param pipeline exactly:
a frontend control writes into the shared `params` object → `fetchTenders` sends it as query
string → Express validates it with a Zod schema → `queryTenders` applies it as an array
filter. Three layers, three tasks, each independently testable: backend filter logic, backend
API wiring, frontend UI.

**Tech Stack:** TypeScript, Express, Zod, React, React Query, Vitest, Testing Library, MSW,
Supertest.

## Global Constraints

- Tests must NEVER hit the real myprocurement.treasury.gov.my — not applicable here (no
  scraper code touched), but keep using fixtures/fakes per project convention.
- Coverage thresholds (80% lines/branches) are enforced by vitest; do not lower thresholds
  or skip hooks.
- Write the failing test first, run it, confirm it fails for the right reason, then write
  minimal implementation, then commit immediately after green. Never commit red.
- `closingDate` is stored as a plain `'YYYY-MM-DD'` string (no time component) — use direct
  string comparison, no date parsing.

---

### Task 1: Backend filter logic — `queryTenders`

**Files:**
- Modify: `backend/src/query/tenders.ts`
- Test: `backend/test/query.test.ts`

**Interfaces:**
- Produces: `TenderQuery` gains two new optional fields, `closingFrom?: string` and
  `closingTo?: string`, consumed by Task 2 (`QuerySchema` in `app.ts`) and Task 3 (frontend
  `params` object).

- [ ] **Step 1: Write the failing tests**

Add this block inside the existing `describe('queryTenders', ...)` in
`backend/test/query.test.ts`, after the `'filters by source...'` test (around line 87):

```ts
  it('filters by closingFrom, inclusive, excluding tenders with a null closingDate', () => {
    const data = [
      t({ closingDate: '2026-07-10' }),
      t({ closingDate: '2026-07-15' }),
      t({ closingDate: '2026-07-20' }),
      t({ closingDate: null }),
    ];
    expect(queryTenders(data, { closingFrom: '2026-07-15' }).total).toBe(2);
    expect(queryTenders(data, { closingFrom: '2026-07-10' }).total).toBe(3);
  });

  it('filters by closingTo, inclusive, excluding tenders with a null closingDate', () => {
    const data = [
      t({ closingDate: '2026-07-10' }),
      t({ closingDate: '2026-07-15' }),
      t({ closingDate: '2026-07-20' }),
      t({ closingDate: null }),
    ];
    expect(queryTenders(data, { closingTo: '2026-07-15' }).total).toBe(2);
    expect(queryTenders(data, { closingTo: '2026-07-20' }).total).toBe(3);
  });

  it('filters by closingFrom and closingTo together as an inclusive range', () => {
    const data = [
      t({ closingDate: '2026-07-05' }),
      t({ closingDate: '2026-07-15' }),
      t({ closingDate: '2026-07-25' }),
      t({ closingDate: null }),
    ];
    const page = queryTenders(data, { closingFrom: '2026-07-10', closingTo: '2026-07-20' });
    expect(page.total).toBe(1);
    expect(page.items[0]!.closingDate).toBe('2026-07-15');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- query.test.ts`
Expected: FAIL — `closingFrom`/`closingTo` are not recognized by `TenderQuery`'s type, or
(since TypeScript excess-property checks don't apply to inline object literals passed
positionally in this way, they will type-check but) the three new tests fail their
assertions because `queryTenders` doesn't yet filter on these fields — all three tests
return the full unfiltered count instead of the expected filtered count.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/query/tenders.ts`, add the two fields to `TenderQuery` (after line 8,
`source?: string;`):

```ts
  source?: string;
  closingFrom?: string;
  closingTo?: string;
```

Then add the filter logic in `queryTenders`, after the existing `if (q.source) ...` line
(line 50):

```ts
  if (q.source) items = items.filter((t) => t.sources.some((s) => s.source === q.source));
  if (q.closingFrom) {
    items = items.filter((t) => t.closingDate !== null && t.closingDate >= q.closingFrom!);
  }
  if (q.closingTo) {
    items = items.filter((t) => t.closingDate !== null && t.closingDate <= q.closingTo!);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend -- query.test.ts`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/query/tenders.ts backend/test/query.test.ts
git commit -m "feat(backend): filter tenders by closing date range"
```

---

### Task 2: Backend API wiring — `QuerySchema`

**Files:**
- Modify: `backend/src/api/app.ts`
- Test: `backend/test/app.test.ts`

**Interfaces:**
- Consumes: `TenderQuery.closingFrom` / `TenderQuery.closingTo` from Task 1, and
  `queryTenders` (already imported in `app.ts`).
- Produces: `GET /api/tenders` accepts `closingFrom`/`closingTo` query params end-to-end,
  consumed by Task 3 (frontend `fetchTenders(params)` calls).

- [ ] **Step 1: Write the failing test**

Add this test to `backend/test/app.test.ts`, after the `'GET /api/tenders supports a
contractor filter...'` test (around line 87):

```ts
  it('GET /api/tenders supports closingFrom and closingTo as an inclusive date range', async () => {
    repo.mergeMany([
      patch({ closingDate: '2026-07-05' }),
      patch({ closingDate: '2026-07-15' }),
      patch({ closingDate: '2026-07-25' }),
    ]);
    const res = await request(app).get('/api/tenders?closingFrom=2026-07-10&closingTo=2026-07-20');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend -- app.test.ts`
Expected: FAIL — `expect(res.body.total).toBe(1)` receives `3`, because `QuerySchema` has
no `closingFrom`/`closingTo` fields yet, so `parsed.data` passed to `queryTenders` doesn't
carry them and no filtering happens. (Zod's default `z.object` strips unrecognized keys
rather than rejecting them, so the request still returns 200 with all 3 results.)

- [ ] **Step 3: Write minimal implementation**

In `backend/src/api/app.ts`, add to `QuerySchema` (after line 19, `source: z.string().optional(),`):

```ts
  source: z.string().optional(),
  closingFrom: z.string().optional(),
  closingTo: z.string().optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w backend -- app.test.ts`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/app.ts backend/test/app.test.ts
git commit -m "feat(backend): accept closingFrom/closingTo query params on GET /api/tenders"
```

---

### Task 3: Frontend UI — `TenderListPage`

**Files:**
- Modify: `frontend/src/pages/TenderListPage.tsx`
- Test: `frontend/src/test/TenderListPage.test.tsx`

**Interfaces:**
- Consumes: `fetchTenders(params: Record<string, string>)` from `frontend/src/api/client.ts`
  (unchanged signature — `closingFrom`/`closingTo` just become two more keys in the object).
- Produces: nothing consumed by later tasks — this is the last task.

- [ ] **Step 1: Write the failing test**

Add this test to `frontend/src/test/TenderListPage.test.tsx`, after the `'populates the
Source filter from facets...'` test (around line 132). Note `fireEvent` must be added to
the existing `@testing-library/react` import on line 2 (jsdom's `input[type="date"]` does
not support character-by-character `userEvent.type`; `fireEvent.change` is the correct way
to set its value in tests):

```ts
  it('sends closingFrom and closingTo as query params when the date range is set', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    fireEvent.change(screen.getByLabelText(/closing from/i), { target: { value: '2026-07-10' } });
    fireEvent.change(screen.getByLabelText(/closing to/i), { target: { value: '2026-07-20' } });
    await waitFor(() => expect(requests.some((u) =>
      u.includes('closingFrom=2026-07-10') && u.includes('closingTo=2026-07-20'))).toBe(true));
  });
```

And update the import line at the top of the file:

```ts
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend -- TenderListPage.test.tsx`
Expected: FAIL — `screen.getByLabelText(/closing from/i)` throws because no such labeled
element exists yet.

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/pages/TenderListPage.tsx`:

Add two new state fields, after line 42 (`const [fieldCode, setFieldCode] = useState('');`):

```ts
  const [fieldCode, setFieldCode] = useState('');
  const [closingFrom, setClosingFrom] = useState('');
  const [closingTo, setClosingTo] = useState('');
```

Include both in the `params` object, after line 61 (`...(fieldCode ? { fieldCode } : {}),`):

```ts
    ...(fieldCode ? { fieldCode } : {}),
    ...(closingFrom ? { closingFrom } : {}),
    ...(closingTo ? { closingTo } : {}),
    ...filters,
```

Add the two date inputs to the filter row's JSX, after the `<FieldCodeFilter .../>` line
(line 116):

```tsx
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend -- TenderListPage.test.tsx`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Run the full workspace test suite**

Run: `npm test`
Expected: PASS, all workspaces green (this also re-confirms Tasks 1 and 2 still pass
together with the frontend change).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/TenderListPage.tsx frontend/src/test/TenderListPage.test.tsx
git commit -m "feat(frontend): add closing-date range filter to tender list pages"
```
