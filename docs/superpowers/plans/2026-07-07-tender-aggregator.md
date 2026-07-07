# Malaysia Tender Aggregator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A website consolidating publicly available Malaysian government tenders (MyProcurement first), with a searchable list page, a detail page, and a rescrape button.

**Architecture:** npm-workspaces TypeScript monorepo: `shared/` (Zod tender schema — the standardized cross-source model), `backend/` (Express API + pluggable scraper adapters + JSON-file repository), `frontend/` (React + Vite + Tailwind + React Query). Docker Compose runs backend and an nginx-served frontend.

**Tech Stack:** TypeScript, Zod, Express 4, cheerio, tsx (backend runtime), Vitest + supertest + React Testing Library + MSW, React 18, Vite, Tailwind v4, @tanstack/react-query, react-router-dom, Docker Compose, husky.

**Spec:** `docs/superpowers/specs/2026-07-07-tender-aggregator-design.md` — read it before starting any task.

## Global Constraints

- TDD is mandatory: write the failing test first, watch it fail, implement, watch it pass, commit. Never write implementation before its test.
- Coverage thresholds: 80% lines / 80% branches in every workspace's vitest config.
- Tests NEVER hit the real myprocurement.treasury.gov.my site. All network access in tests is mocked/fixtured. (One-time fixture capture via curl is a dev step, not a test.)
- MyProcurement API: `category` and `type` query params are ALWAYS passed explicitly. Open tenders: `type=advertisements` + `category=quotation|tender|requisition`. Archive: `type=archive` + `category=advertisement-quotation|advertisement-tender|advertisement-requisition`. 6 jobs total.
- Rescrape (`POST /api/scrape`) runs only the 3 open jobs. Archive backfill runs once at startup (resumable via `lastArchiveBackfillAt` in meta).
- Rate limiting: serial requests, 300ms base delay + 0–200ms jitter (env `SCRAPE_DELAY_MS` overrides base), retry ×3 with backoff 1s/4s/16s, honor `Retry-After` on 429/503 (first honored wait doesn't consume an attempt, else 60s penalty), identifying User-Agent `TenderAggregatorBot/1.0`.
- Cross-source dedup: `dedupKey` = referenceNo uppercased with ALL whitespace stripped; falls back to `id` when referenceNo is empty. Query layer serves one canonical record per dedupKey (most non-null fields wins, tie → newest scrapedAt).
- Node 22. ESM everywhere (`"type": "module"`).
- Commit after every green test cycle. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure (final)

```
tms-v2/
├── package.json                      # workspaces root, husky, test script
├── .gitignore
├── .husky/pre-commit
├── tsconfig.base.json
├── CLAUDE.md
├── README.md
├── docker-compose.yml
├── shared/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   └── src/
│       ├── index.ts                  # re-exports
│       └── tender.ts                 # TenderSchema, Tender, computeDedupKey
│   └── test/tender.test.ts
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── Dockerfile
│   ├── data/                         # gitignored JSON storage
│   ├── src/
│   │   ├── index.ts                  # bootstrap: repo load, startup scrape, listen
│   │   ├── parsing/text.ts           # parseDdMmYyyy, parseRmPrice, splitFieldCodes
│   │   ├── http/politeFetch.ts       # createPoliteFetcher (rate limiting)
│   │   ├── scrapers/types.ts         # ScraperAdapter, ScrapeScope, ScrapeProgress
│   │   ├── scrapers/myprocurement/parseListing.ts
│   │   ├── scrapers/myprocurement/adapter.ts
│   │   ├── storage/repository.ts     # TenderRepository (JSON files, atomic writes)
│   │   ├── query/tenders.ts          # dedupe, filter/sort/paginate, facets, findById
│   │   ├── scrape/manager.ts         # ScrapeManager (status, start, orchestration)
│   │   └── api/app.ts                # createApp(deps) → Express app
│   └── test/
│       ├── fixtures/                 # captured API responses (committed)
│       ├── text.test.ts
│       ├── politeFetch.test.ts
│       ├── parseListing.test.ts
│       ├── adapter.test.ts
│       ├── repository.test.ts
│       ├── query.test.ts
│       ├── app.test.ts
│       └── manager.test.ts
└── frontend/
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts                # also vitest config
    ├── Dockerfile
    ├── nginx.conf
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx                   # router + layout + ScrapeBanner
        ├── index.css
        ├── api/client.ts             # typed API client
        ├── api/types.ts              # response types (mirrors backend)
        ├── pages/MainPage.tsx
        ├── pages/DetailPage.tsx
        ├── components/ScrapeBanner.tsx
        └── test/
            ├── setup.ts              # MSW server + RTL cleanup
            ├── mocks.ts              # MSW handlers + sample tenders
            ├── MainPage.test.tsx
            ├── DetailPage.test.tsx
            └── ScrapeBanner.test.tsx
```

---

### Task 1: Monorepo scaffold + tooling

**Files:**
- Create: `package.json`, `.gitignore`, `tsconfig.base.json`, `.husky/pre-commit`
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/vitest.config.ts`, `shared/src/index.ts`
- Create: `backend/package.json`, `backend/tsconfig.json`, `backend/vitest.config.ts`
- Create: `CLAUDE.md`, `README.md` (initial versions; finalized in Task 16)

**Interfaces:**
- Produces: `npm test` at root runs vitest in every workspace; `tsconfig.base.json` extended by all workspaces; shared importable as package name `@tms/shared`.

*(Frontend workspace is scaffolded by Vite in Task 11; root `workspaces` already lists it.)*

- [ ] **Step 1: Root package.json, gitignore, base tsconfig**

`package.json`:
```json
{
  "name": "tms-v2",
  "private": true,
  "type": "module",
  "workspaces": ["shared", "backend", "frontend"],
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "prepare": "husky"
  },
  "devDependencies": {}
}
```

`.gitignore`:
```
node_modules/
dist/
coverage/
backend/data/
*.tsbuildinfo
.env
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true
  }
}
```

- [ ] **Step 2: shared workspace skeleton**

`shared/package.json`:
```json
{
  "name": "@tms/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": { "test": "vitest run" },
  "dependencies": { "zod": "^3.23.0" },
  "devDependencies": { "typescript": "^5.5.0", "vitest": "^2.0.0", "@vitest/coverage-v8": "^2.0.0" }
}
```

`shared/tsconfig.json`:
```json
{ "extends": "../tsconfig.base.json", "include": ["src", "test"] }
```

`shared/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: { lines: 80, branches: 80 },
    },
  },
});
```

`shared/src/index.ts`:
```ts
export {};
```

- [ ] **Step 3: backend workspace skeleton**

`backend/package.json`:
```json
{
  "name": "@tms/backend",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@tms/shared": "*",
    "cheerio": "^1.0.0",
    "express": "^4.19.0",
    "tsx": "^4.16.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "@types/supertest": "^6.0.0",
    "supertest": "^7.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "@vitest/coverage-v8": "^2.0.0"
  }
}
```

`backend/tsconfig.json`:
```json
{ "extends": "../tsconfig.base.json", "include": ["src", "test"] }
```

`backend/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/index.ts'],
      thresholds: { lines: 80, branches: 80 },
    },
  },
});
```
(`src/index.ts` is the process bootstrap — wiring only, excluded from coverage; everything it wires is covered via `manager.test.ts` and `app.test.ts`.)

- [ ] **Step 4: Install and verify test runner works**

Run: `npm install && npm install -D husky -w . && npm test`
Expected: vitest runs in shared and backend, both report "no tests" but exit 0 (passWithNoTests).

- [ ] **Step 5: Husky pre-commit hook**

Run: `npx husky init`
Then overwrite `.husky/pre-commit` with:
```sh
npm test
```

- [ ] **Step 6: Initial CLAUDE.md and README.md**

`CLAUDE.md`:
```markdown
# tms-v2 — Malaysia Tender Aggregator

Consolidates publicly available Malaysian government tenders from multiple sources
(currently MyProcurement) into one searchable web app.

## Stack
- npm workspaces monorepo: `shared/` (Zod tender schema), `backend/` (Express + scrapers,
  JSON-file storage in `backend/data/`), `frontend/` (React + Vite + Tailwind).
- Node 22, TypeScript, ESM everywhere.

## Commands
- `npm test` — run all workspace test suites (also runs on pre-commit via husky)
- `npm run dev -w backend` — backend on :3001
- `npm run dev -w frontend` — frontend on :5173 (proxies /api to :3001)
- `docker compose up --build` — full stack, frontend on :8080

## TDD — non-negotiable
1. Write the failing test FIRST. Run it. Confirm it fails for the right reason.
2. Write the minimal implementation. Run the test. Confirm it passes.
3. Commit immediately after green. Never commit red.
4. Coverage thresholds (80% lines/branches) are enforced by vitest; pre-commit runs the
   full suite. Do not lower thresholds or skip hooks.
5. Tests must NEVER hit the real myprocurement.treasury.gov.my. Use fixtures in
   `backend/test/fixtures/` and injected fakes.

## Key design rules (see docs/superpowers/specs/2026-07-07-tender-aggregator-design.md)
- All scrapers emit the shared `Tender` schema (`shared/src/tender.ts`). Zod-validate
  every record; invalid records are logged and skipped, never stored.
- MyProcurement requires explicit `type` + `category` params — 6 job combinations.
  Archive categories use the `advertisement-` prefix.
- Rescrape button = open jobs only. Archive backfill = once, at startup, resumable.
- Rate limiting: serial requests, delay + jitter, backoff, honor Retry-After.
- Cross-source dedup by `dedupKey` (normalized referenceNo) at query time.

## Adding a new data source
1. Create `backend/src/scrapers/<source>/adapter.ts` implementing `ScraperAdapter`
   (`backend/src/scrapers/types.ts`).
2. Emit `Tender` records with `source: '<source>'`, `id: '<source>:<sourceId>'`,
   `dedupKey: computeDedupKey(referenceNo, id)`.
3. Register it in the adapters array in `backend/src/index.ts`.
4. Fixture-based parser tests first, adapter tests with fake fetcher second.
```

`README.md`:
```markdown
# Malaysia Tender Aggregator

Web app consolidating publicly available Malaysian government tenders into one
searchable interface. Data sources are scraped on the backend, normalized into a
standardized schema, and served to a React frontend.

Work in progress — see `docs/superpowers/specs/` for the design and
`docs/superpowers/plans/` for the implementation plan.
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: monorepo scaffold with workspaces, vitest, husky"
```

---

### Task 2: Shared tender schema + dedup key

**Files:**
- Create: `shared/src/tender.ts`
- Modify: `shared/src/index.ts`
- Test: `shared/test/tender.test.ts`

**Interfaces:**
- Produces:
  - `TenderSchema: z.ZodType` and `type Tender = z.infer<typeof TenderSchema>` with fields exactly as in the spec's schema block (id, source, sourceId, referenceNo, dedupKey, title, sourceUrl, status: 'open'|'closed', procurementType: 'quotation'|'tender'|'requisition', ministry, agency, category, fieldCodes: string[], advertisedDate, closingDate, indicativePrice, currency: 'MYR', events: {label, date, address}[], raw: Record<string,string>, scrapedAt).
  - `computeDedupKey(referenceNo: string, id: string): string`
  - `type TenderEvent = { label: string; date: string | null; address: string | null }`

- [ ] **Step 1: Write the failing test**

`shared/test/tender.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { TenderSchema, computeDedupKey, type Tender } from '../src/tender.js';

export function makeTender(overrides: Partial<Tender> = {}): Tender {
  return {
    id: 'myprocurement:789195',
    source: 'myprocurement',
    sourceId: '789195',
    referenceNo: 'UTHM/54(KTKEM)/P/02/023/2026(1)',
    dedupKey: 'UTHM/54(KTKEM)/P/02/023/2026(1)',
    title: 'MENYELENGGARA PERALATAN MAKMAL',
    sourceUrl: 'https://myprocurement.treasury.gov.my/advertisements/quotation/71ebb6ee',
    status: 'open',
    procurementType: 'quotation',
    ministry: 'KEMENTERIAN PENDIDIKAN TINGGI',
    agency: 'UNIVERSITI TUN HUSSEIN ONN MALAYSIA (UTHM)',
    category: 'Perkhidmatan Bukan Perunding',
    fieldCodes: ['060501'],
    advertisedDate: '2026-07-07',
    closingDate: '2026-07-17',
    indicativePrice: 28800,
    currency: 'MYR',
    events: [],
    raw: {},
    scrapedAt: '2026-07-07T12:00:00.000Z',
    ...overrides,
  };
}

describe('TenderSchema', () => {
  it('accepts a fully valid tender', () => {
    expect(TenderSchema.parse(makeTender())).toEqual(makeTender());
  });

  it('accepts nullable fields as null', () => {
    const t = makeTender({
      ministry: null, agency: null, category: null,
      advertisedDate: null, closingDate: null, indicativePrice: null,
    });
    expect(TenderSchema.parse(t)).toEqual(t);
  });

  it('rejects empty id/title and bad enums', () => {
    expect(TenderSchema.safeParse(makeTender({ id: '' })).success).toBe(false);
    expect(TenderSchema.safeParse(makeTender({ title: '' })).success).toBe(false);
    expect(TenderSchema.safeParse({ ...makeTender(), status: 'pending' }).success).toBe(false);
    expect(TenderSchema.safeParse({ ...makeTender(), procurementType: 'rfp' }).success).toBe(false);
    expect(TenderSchema.safeParse({ ...makeTender(), currency: 'USD' }).success).toBe(false);
  });

  it('accepts events with nullable date/address', () => {
    const t = makeTender({
      events: [{ label: 'Lawatan Tapak', date: '2026-07-10', address: 'MAKMAL OR, BLOK A' }],
    });
    expect(TenderSchema.parse(t).events).toHaveLength(1);
  });
});

describe('computeDedupKey', () => {
  it('uppercases and strips all whitespace', () => {
    expect(computeDedupKey('uthm/54 (ktkem) /p/02', 'x')).toBe('UTHM/54(KTKEM)/P/02');
  });
  it('falls back to id when referenceNo is empty or whitespace-only', () => {
    expect(computeDedupKey('', 'myprocurement:1')).toBe('myprocurement:1');
    expect(computeDedupKey('   ', 'myprocurement:1')).toBe('myprocurement:1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w shared`
Expected: FAIL — cannot resolve `../src/tender.js`.

- [ ] **Step 3: Write minimal implementation**

`shared/src/tender.ts`:
```ts
import { z } from 'zod';

export const TenderEventSchema = z.object({
  label: z.string(),
  date: z.string().nullable(),
  address: z.string().nullable(),
});
export type TenderEvent = z.infer<typeof TenderEventSchema>;

export const TenderSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceId: z.string().min(1),
  referenceNo: z.string(),
  dedupKey: z.string().min(1),
  title: z.string().min(1),
  sourceUrl: z.string().url(),
  status: z.enum(['open', 'closed']),
  procurementType: z.enum(['quotation', 'tender', 'requisition']),
  ministry: z.string().nullable(),
  agency: z.string().nullable(),
  category: z.string().nullable(),
  fieldCodes: z.array(z.string()),
  advertisedDate: z.string().nullable(),
  closingDate: z.string().nullable(),
  indicativePrice: z.number().nullable(),
  currency: z.literal('MYR'),
  events: z.array(TenderEventSchema),
  raw: z.record(z.string()),
  scrapedAt: z.string(),
});
export type Tender = z.infer<typeof TenderSchema>;

export function computeDedupKey(referenceNo: string, id: string): string {
  const normalized = referenceNo.toUpperCase().replace(/\s+/g, '');
  return normalized.length > 0 ? normalized : id;
}
```

`shared/src/index.ts`:
```ts
export * from './tender.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w shared`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add shared
git commit -m "feat(shared): standardized Tender schema and dedup key"
```

---

### Task 3: Backend text parsing utilities

**Files:**
- Create: `backend/src/parsing/text.ts`
- Test: `backend/test/text.test.ts`

**Interfaces:**
- Produces: `parseDdMmYyyy(s: string | null | undefined): string | null`, `parseRmPrice(s: string | null | undefined): number | null`, `splitFieldCodes(s: string | null | undefined): string[]`.

- [ ] **Step 1: Write the failing test**

`backend/test/text.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseDdMmYyyy, parseRmPrice, splitFieldCodes } from '../src/parsing/text.js';

describe('parseDdMmYyyy', () => {
  it('parses dd/mm/yyyy into ISO date', () => {
    expect(parseDdMmYyyy('07/07/2026')).toBe('2026-07-07');
    expect(parseDdMmYyyy(' 17/07/2026 ')).toBe('2026-07-17');
  });
  it('returns null for invalid or missing input', () => {
    expect(parseDdMmYyyy('2026-07-07')).toBeNull();
    expect(parseDdMmYyyy('32/01/2026')).toBeNull();
    expect(parseDdMmYyyy('30/02/2026')).toBeNull();
    expect(parseDdMmYyyy('')).toBeNull();
    expect(parseDdMmYyyy(null)).toBeNull();
    expect(parseDdMmYyyy(undefined)).toBeNull();
  });
});

describe('parseRmPrice', () => {
  it('parses RM amounts with thousands separators', () => {
    expect(parseRmPrice('RM 28,800.00')).toBe(28800);
    expect(parseRmPrice('RM 1,084,000.00')).toBe(1084000);
    expect(parseRmPrice('rm 20,000.00')).toBe(20000);
  });
  it('returns null when no parseable amount', () => {
    expect(parseRmPrice('')).toBeNull();
    expect(parseRmPrice('TIADA')).toBeNull();
    expect(parseRmPrice(null)).toBeNull();
    expect(parseRmPrice(undefined)).toBeNull();
  });
});

describe('splitFieldCodes', () => {
  it('splits comma-separated codes and trims', () => {
    expect(splitFieldCodes('221001, 221002, 221003')).toEqual(['221001', '221002', '221003']);
    expect(splitFieldCodes('E05, E32')).toEqual(['E05', 'E32']);
    expect(splitFieldCodes('060501')).toEqual(['060501']);
  });
  it('returns [] for empty input', () => {
    expect(splitFieldCodes('')).toEqual([]);
    expect(splitFieldCodes(null)).toEqual([]);
    expect(splitFieldCodes(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend`
Expected: FAIL — cannot resolve `../src/parsing/text.js`.

- [ ] **Step 3: Write minimal implementation**

`backend/src/parsing/text.ts`:
```ts
export function parseDdMmYyyy(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (date.getUTCFullYear() !== yyyy || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) {
    return null;
  }
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export function parseRmPrice(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/RM\s*(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : null;
}

export function splitFieldCodes(s: string | null | undefined): string[] {
  if (!s) return [];
  return s.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w backend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/parsing backend/test/text.test.ts
git commit -m "feat(backend): date/price/field-code parsing utilities"
```

---

### Task 4: Fixture capture + MyProcurement listing parser

**Files:**
- Create: `backend/test/fixtures/open-quotation-p1.json`, `open-tender-p1.json`, `open-requisition-p1.json`, `archive-quotation-p1.json` (captured, committed)
- Create: `backend/src/scrapers/myprocurement/parseListing.ts`
- Test: `backend/test/parseListing.test.ts`

**Interfaces:**
- Consumes: `parseDdMmYyyy`, `parseRmPrice`, `splitFieldCodes` (Task 3); `TenderSchema`, `computeDedupKey` (Task 2).
- Produces: `parseListingHtml(html: string, ctx: JobContext): Tender[]` and `type JobContext = { status: 'open' | 'closed'; procurementType: 'quotation' | 'tender' | 'requisition'; now?: () => string }`. Every returned record already passes `TenderSchema.parse`; unparseable cards are skipped with a `console.warn`.

- [ ] **Step 1: Capture live fixtures (one-time dev step, NOT a test)**

```bash
mkdir -p backend/test/fixtures
UA="TenderAggregatorBot/1.0"
B="https://myprocurement.treasury.gov.my/procurements/fetch?page=1&itemsPerPage=10"
curl -s "$B&type=advertisements&category=quotation"   -H "User-Agent: $UA" -o backend/test/fixtures/open-quotation-p1.json
sleep 1
curl -s "$B&type=advertisements&category=tender"      -H "User-Agent: $UA" -o backend/test/fixtures/open-tender-p1.json
sleep 1
curl -s "$B&type=advertisements&category=requisition" -H "User-Agent: $UA" -o backend/test/fixtures/open-requisition-p1.json
sleep 1
curl -s "$B&type=archive&category=advertisement-quotation" -H "User-Agent: $UA" -o backend/test/fixtures/archive-quotation-p1.json
```
Verify each file is valid JSON with `html`, `total`, `page`, `lastPage` keys (e.g. `node -e "const d=require('./backend/test/fixtures/open-quotation-p1.json'); console.log(d.total, d.lastPage)"`). If a capture fails (network), retry once; these fixtures are committed so this never runs again.

- [ ] **Step 2: Write the failing test**

`backend/test/parseListing.test.ts` — two layers: exact-value assertions against an embedded single-card fixture (deterministic), and structural invariants against the captured live fixtures (broad coverage of real markup, including archive variant):

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TenderSchema } from '@tms/shared';
import { parseListingHtml, type JobContext } from '../src/scrapers/myprocurement/parseListing.js';

const NOW = () => '2026-07-07T12:00:00.000Z';
const OPEN_Q: JobContext = { status: 'open', procurementType: 'quotation', now: NOW };

// Single card verbatim from the real API response shape (entities included), with an
// events table, so exact values can be asserted deterministically.
const CARD_HTML = `<div>
  <div x-data="{ selected: false, open: true }" class="flex flex-col">
    <div class="flex">
      <button x-on:click="selected = !selected; $dispatch('select-procurement', { id: 789195 })"></button>
    </div>
    <div class="flex-grow text-sm md:text-base break-words">
      <div>
        <div class="mx-4 px-4 py-2 inline-block rounded-md bg-primary/20">
          Tarikh Pelawaan: 07/07/2026
        </div>
        <div class="px-4 py-2 rounded-md">
          <span class="font-bold">No. Sebut Harga</span>: UTHM/54(KTKEM)/P/02/023/2026(1)
        </div>
        <div class="px-4 py-2 rounded-md text-justify font-bold text-primary uppercase">
          <a href="https://myprocurement.treasury.gov.my/advertisements/quotation/71ebb6ee">MAKMAL ELEKTRIK &amp; ELEKTRONIK 2</a>
        </div>
        <div x-show="open" class="flex flex-col w-full px-4">
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Kementerian:</div>
            <div class="w-full sm:w-2/3 uppercase">KEMENTERIAN PENDIDIKAN TINGGI</div>
          </div>
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Agensi:</div>
            <div class="w-full sm:w-2/3 uppercase">UNIVERSITI TUN HUSSEIN ONN MALAYSIA (UTHM)</div>
          </div>
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Kategori Perolehan:</div>
            <div class="w-full sm:w-2/3 uppercase">Perkhidmatan Bukan Perunding</div>
          </div>
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Kod Bidang:</div>
            <div class="w-full sm:w-2/3 uppercase">E05, E32</div>
          </div>
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Tarikh Tutup Pelawaan:</div>
            <div class="w-full sm:w-2/3 uppercase">17/07/2026</div>
          </div>
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Harga Indikatif Jabatan:</div>
            <div class="w-full sm:w-2/3 uppercase">RM 28,800.00</div>
          </div>
        </div>
        <div x-show="open" class="mt-2 w-full">
          <table class="w-full hidden md:block">
            <tr class="bg-primary/20"><th>Bil.</th><th>Perkara</th><th>Tarikh</th><th>Alamat</th></tr>
            <tr class="uppercase">
              <td>1.</td>
              <td>Lawatan Tapak</td>
              <td>10/07/2026</td>
              <td class="w-full">MAKMAL OR, BLOK A, STRIDE, KAJANG, SELANGOR</td>
            </tr>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>`;

describe('parseListingHtml — embedded card, exact values', () => {
  it('extracts every field from a card', () => {
    const [t] = parseListingHtml(CARD_HTML, OPEN_Q);
    expect(t).toBeDefined();
    expect(t!.id).toBe('myprocurement:789195');
    expect(t!.source).toBe('myprocurement');
    expect(t!.sourceId).toBe('789195');
    expect(t!.referenceNo).toBe('UTHM/54(KTKEM)/P/02/023/2026(1)');
    expect(t!.dedupKey).toBe('UTHM/54(KTKEM)/P/02/023/2026(1)');
    expect(t!.title).toBe('MAKMAL ELEKTRIK & ELEKTRONIK 2'); // entity decoded
    expect(t!.sourceUrl).toBe('https://myprocurement.treasury.gov.my/advertisements/quotation/71ebb6ee');
    expect(t!.status).toBe('open');
    expect(t!.procurementType).toBe('quotation');
    expect(t!.ministry).toBe('KEMENTERIAN PENDIDIKAN TINGGI');
    expect(t!.agency).toBe('UNIVERSITI TUN HUSSEIN ONN MALAYSIA (UTHM)');
    expect(t!.category).toBe('Perkhidmatan Bukan Perunding');
    expect(t!.fieldCodes).toEqual(['E05', 'E32']);
    expect(t!.advertisedDate).toBe('2026-07-07');
    expect(t!.closingDate).toBe('2026-07-17');
    expect(t!.indicativePrice).toBe(28800);
    expect(t!.events).toEqual([
      { label: 'Lawatan Tapak', date: '2026-07-10', address: 'MAKMAL OR, BLOK A, STRIDE, KAJANG, SELANGOR' },
    ]);
    expect(t!.raw['No. Sebut Harga']).toBe('UTHM/54(KTKEM)/P/02/023/2026(1)');
    expect(t!.raw['Harga Indikatif Jabatan']).toBe('RM 28,800.00');
    expect(t!.scrapedAt).toBe('2026-07-07T12:00:00.000Z');
  });

  it('tags status/procurementType from the job context, not page text', () => {
    const [t] = parseListingHtml(CARD_HTML, { status: 'closed', procurementType: 'tender', now: NOW });
    expect(t!.status).toBe('closed');
    expect(t!.procurementType).toBe('tender');
  });

  it('skips cards without a title link instead of throwing', () => {
    const broken = CARD_HTML.replace(/<a href="[^"]*">.*?<\/a>/s, '');
    expect(parseListingHtml(broken, OPEN_Q)).toEqual([]);
  });
});

const FIXTURES: Array<{ file: string; ctx: JobContext }> = [
  { file: 'open-quotation-p1.json', ctx: { status: 'open', procurementType: 'quotation', now: NOW } },
  { file: 'open-tender-p1.json', ctx: { status: 'open', procurementType: 'tender', now: NOW } },
  { file: 'open-requisition-p1.json', ctx: { status: 'open', procurementType: 'requisition', now: NOW } },
  { file: 'archive-quotation-p1.json', ctx: { status: 'closed', procurementType: 'quotation', now: NOW } },
];

describe('parseListingHtml — live fixtures, structural invariants', () => {
  for (const { file, ctx } of FIXTURES) {
    it(`parses every card in ${file} into schema-valid tenders`, () => {
      const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', file), 'utf8'));
      const tenders = parseListingHtml(raw.html, ctx);
      expect(tenders.length).toBeGreaterThan(0);
      // Every select-procurement id in the HTML must yield a parsed tender: nothing missed.
      const idsInHtml = new Set([...raw.html.matchAll(/select-procurement'?,?\s*\{\s*id:\s*(\d+)/g)].map((m) => m[1]));
      expect(new Set(tenders.map((t) => t.sourceId))).toEqual(idsInHtml);
      for (const t of tenders) {
        expect(() => TenderSchema.parse(t)).not.toThrow();
        expect(t.status).toBe(ctx.status);
        expect(t.procurementType).toBe(ctx.procurementType);
        if (t.advertisedDate) expect(t.advertisedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if (t.closingDate) expect(t.closingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  }
});
```

Note: `__dirname` is not defined in ESM vitest by default — add at the top of the test file:
```ts
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w backend`
Expected: FAIL — cannot resolve `../src/scrapers/myprocurement/parseListing.js`.

- [ ] **Step 4: Write the implementation**

`backend/src/scrapers/myprocurement/parseListing.ts`:
```ts
import * as cheerio from 'cheerio';
import type { AnyNode, Cheerio } from 'cheerio';
import { TenderSchema, computeDedupKey, type Tender, type TenderEvent } from '@tms/shared';
import { parseDdMmYyyy, parseRmPrice, splitFieldCodes } from '../../parsing/text.js';

export interface JobContext {
  status: 'open' | 'closed';
  procurementType: 'quotation' | 'tender' | 'requisition';
  now?: () => string;
}

const SOURCE = 'myprocurement';

export function parseListingHtml(html: string, ctx: JobContext): Tender[] {
  const $ = cheerio.load(html);
  const now = ctx.now ?? (() => new Date().toISOString());
  const tenders: Tender[] = [];

  $('div[x-data]').each((_, el) => {
    const card = $(el);
    const xData = card.attr('x-data') ?? '';
    if (!xData.includes('selected')) return; // pagination wrapper etc.

    const candidate = parseCard($, card, ctx, now());
    if (!candidate) return;
    const result = TenderSchema.safeParse(candidate);
    if (!result.success) {
      console.warn(`[myprocurement] skipping invalid card: ${result.error.message}`);
      return;
    }
    tenders.push(result.data);
  });

  return tenders;
}

function parseCard(
  $: cheerio.CheerioAPI,
  card: Cheerio<AnyNode>,
  ctx: JobContext,
  scrapedAt: string,
): Record<string, unknown> | null {
  const idMatch = card.html()?.match(/select-procurement'?,?\s*\{\s*id:\s*(\d+)/);
  if (!idMatch) return null;
  const sourceId = idMatch[1]!;

  const link = card.find('div.font-bold.text-primary a').first();
  const title = clean(link.text());
  const sourceUrl = link.attr('href') ?? '';
  if (!title || !sourceUrl) return null;

  const raw: Record<string, string> = {};

  // Label/value detail rows: <div class="... font-bold align-top">Label:</div><div>Value</div>
  card.find('div.font-bold.align-top').each((_, labelEl) => {
    const label = clean($(labelEl).text()).replace(/:$/, '');
    const value = clean($(labelEl).next('div').text());
    if (label) raw[label] = value;
  });

  // Reference number row: <span class="font-bold">No. Sebut Harga</span>: VALUE
  let referenceNo = '';
  card.find('span.font-bold').each((_, spanEl) => {
    const span = $(spanEl);
    const label = clean(span.text());
    if (!label.startsWith('No.')) return;
    const parentText = clean(span.parent().text());
    referenceNo = clean(parentText.slice(parentText.indexOf(label) + label.length).replace(/^:/, ''));
    raw[label] = referenceNo;
  });

  // Advertised date badge: "Tarikh Pelawaan: 07/07/2026"
  const badgeMatch = card.text().match(/Tarikh Pelawaan:\s*([\d/]+)/);
  if (badgeMatch) raw['Tarikh Pelawaan'] = badgeMatch[1]!;

  // Events from the desktop table: Bil. | Perkara | Tarikh | Alamat
  const events: TenderEvent[] = [];
  card.find('table tr').each((_, rowEl) => {
    const cells = $(rowEl).find('td');
    if (cells.length < 4) return;
    events.push({
      label: clean(cells.eq(1).text()),
      date: parseDdMmYyyy(clean(cells.eq(2).text())),
      address: clean(cells.eq(3).text()) || null,
    });
  });

  const id = `${SOURCE}:${sourceId}`;
  return {
    id,
    source: SOURCE,
    sourceId,
    referenceNo,
    dedupKey: computeDedupKey(referenceNo, id),
    title,
    sourceUrl,
    status: ctx.status,
    procurementType: ctx.procurementType,
    ministry: raw['Kementerian'] || null,
    agency: raw['Agensi'] || null,
    category: raw['Kategori Perolehan'] || null,
    fieldCodes: splitFieldCodes(raw['Kod Bidang']),
    advertisedDate: parseDdMmYyyy(raw['Tarikh Pelawaan']),
    closingDate: parseDdMmYyyy(raw['Tarikh Tutup Pelawaan']),
    indicativePrice: parseRmPrice(raw['Harga Indikatif Jabatan']),
    currency: 'MYR' as const,
    events,
    raw,
    scrapedAt,
  };
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w backend`
Expected: PASS. If a live-fixture invariant fails, inspect the actual markup in that fixture (e.g. archive cards may label the reference "No. Tender" — the `startsWith('No.')` handling covers that; the label/value row classes may differ) and adjust selectors — do NOT weaken the "every id in HTML is parsed" invariant.

- [ ] **Step 6: Commit**

```bash
git add backend/test/fixtures backend/test/parseListing.test.ts backend/src/scrapers
git commit -m "feat(backend): MyProcurement listing parser with real-response fixtures"
```

---

### Task 5: Polite fetcher (rate limiting)

**Files:**
- Create: `backend/src/http/politeFetch.ts`
- Test: `backend/test/politeFetch.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface PoliteFetcherOptions {
    baseDelayMs?: number;      // default: Number(process.env.SCRAPE_DELAY_MS) || 300
    jitterMs?: number;         // default 200
    maxAttempts?: number;      // default 3
    backoffMs?: number[];      // default [1000, 4000, 16000]
    penaltyMs?: number;        // default 60000 (429/503 without Retry-After)
    fetchImpl?: typeof fetch;  // injected in tests
    sleep?: (ms: number) => Promise<void>;  // injected in tests
    random?: () => number;     // injected in tests
  }
  function createPoliteFetcher(opts?: PoliteFetcherOptions): (url: string) => Promise<unknown>
  ```
  Returned function resolves with parsed JSON. Throws `Error('fetch failed after N attempts: <url>')` when the budget is exhausted. Sends header `User-Agent: TenderAggregatorBot/1.0`.

- [ ] **Step 1: Write the failing test**

`backend/test/politeFetch.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { createPoliteFetcher } from '../src/http/politeFetch.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function setup(responses: Array<Response | Error>) {
  const sleeps: number[] = [];
  const sleep = vi.fn(async (ms: number) => { sleeps.push(ms); });
  const fetchImpl = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses queued');
    if (next instanceof Error) throw next;
    return next;
  });
  return { sleeps, sleep, fetchImpl };
}

describe('createPoliteFetcher', () => {
  it('returns parsed JSON and waits baseDelay+jitter before each request', async () => {
    const { sleeps, sleep, fetchImpl } = setup([jsonResponse({ ok: 1 })]);
    const f = createPoliteFetcher({ baseDelayMs: 300, jitterMs: 200, fetchImpl, sleep, random: () => 0.5 });
    await expect(f('http://x/a')).resolves.toEqual({ ok: 1 });
    expect(sleeps).toEqual([400]); // 300 + 0.5*200
  });

  it('sends the identifying User-Agent', async () => {
    const { sleep, fetchImpl } = setup([jsonResponse({})]);
    const f = createPoliteFetcher({ fetchImpl, sleep, random: () => 0 });
    await f('http://x/a');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('TenderAggregatorBot/1.0');
  });

  it('retries with exponential backoff on network error, then succeeds', async () => {
    const { sleeps, sleep, fetchImpl } = setup([new Error('boom'), new Error('boom'), jsonResponse({ ok: 1 })]);
    const f = createPoliteFetcher({ baseDelayMs: 0, jitterMs: 0, fetchImpl, sleep, random: () => 0 });
    await expect(f('http://x/a')).resolves.toEqual({ ok: 1 });
    // delays: pre-req(0), backoff 1000, pre-req(0), backoff 4000, pre-req(0)
    expect(sleeps.filter((ms) => ms > 0)).toEqual([1000, 4000]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails after maxAttempts', async () => {
    const { sleep, fetchImpl } = setup([new Error('a'), new Error('b'), new Error('c')]);
    const f = createPoliteFetcher({ baseDelayMs: 0, jitterMs: 0, fetchImpl, sleep, random: () => 0 });
    await expect(f('http://x/a')).rejects.toThrow('fetch failed after 3 attempts');
  });

  it('honors Retry-After on 429 without consuming an attempt (first time only)', async () => {
    const { sleeps, sleep, fetchImpl } = setup([
      jsonResponse({}, 429, { 'Retry-After': '7' }),
      new Error('x'), new Error('x'), jsonResponse({ ok: 1 }),
    ]);
    const f = createPoliteFetcher({ baseDelayMs: 0, jitterMs: 0, fetchImpl, sleep, random: () => 0 });
    // 4 fetches total: the 429 didn't count, then 3 budgeted attempts
    await expect(f('http://x/a')).resolves.toEqual({ ok: 1 });
    expect(sleeps).toContain(7000);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('uses the 60s penalty on 503 without Retry-After', async () => {
    const { sleeps, sleep, fetchImpl } = setup([jsonResponse({}, 503), jsonResponse({ ok: 1 })]);
    const f = createPoliteFetcher({ baseDelayMs: 0, jitterMs: 0, fetchImpl, sleep, random: () => 0 });
    await expect(f('http://x/a')).resolves.toEqual({ ok: 1 });
    expect(sleeps).toContain(60000);
  });

  it('treats other non-ok statuses as failures consuming attempts', async () => {
    const { sleep, fetchImpl } = setup([jsonResponse({}, 500), jsonResponse({}, 500), jsonResponse({}, 500)]);
    const f = createPoliteFetcher({ baseDelayMs: 0, jitterMs: 0, fetchImpl, sleep, random: () => 0 });
    await expect(f('http://x/a')).rejects.toThrow('fetch failed after 3 attempts');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`backend/src/http/politeFetch.ts`:
```ts
export interface PoliteFetcherOptions {
  baseDelayMs?: number;
  jitterMs?: number;
  maxAttempts?: number;
  backoffMs?: number[];
  penaltyMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const USER_AGENT = 'TenderAggregatorBot/1.0';
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createPoliteFetcher(opts: PoliteFetcherOptions = {}) {
  const baseDelayMs = opts.baseDelayMs ?? (Number(process.env.SCRAPE_DELAY_MS) || 300);
  const jitterMs = opts.jitterMs ?? 200;
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffMs = opts.backoffMs ?? [1000, 4000, 16000];
  const penaltyMs = opts.penaltyMs ?? 60000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  return async function politeFetch(url: string): Promise<unknown> {
    let attempt = 0;
    let rateLimitGraceUsed = false;

    while (attempt < maxAttempts) {
      await sleep(baseDelayMs + random() * jitterMs);
      try {
        const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
        if (res.ok) return await res.json();

        if (res.status === 429 || res.status === 503) {
          const retryAfter = Number(res.headers.get('Retry-After'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : penaltyMs;
          await sleep(waitMs);
          if (!rateLimitGraceUsed) {
            rateLimitGraceUsed = true; // first rate-limit wait doesn't consume an attempt
            continue;
          }
        }
        attempt += 1;
      } catch {
        attempt += 1;
      }
      if (attempt < maxAttempts) {
        await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? penaltyMs);
      }
    }
    throw new Error(`fetch failed after ${maxAttempts} attempts: ${url}`);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w backend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/http backend/test/politeFetch.test.ts
git commit -m "feat(backend): polite fetcher with jitter, backoff, Retry-After handling"
```

---

### Task 6: MyProcurement adapter (6 jobs, pagination, batching)

**Files:**
- Create: `backend/src/scrapers/types.ts`
- Create: `backend/src/scrapers/myprocurement/adapter.ts`
- Test: `backend/test/adapter.test.ts`

**Interfaces:**
- Consumes: `parseListingHtml` (Task 4), fetcher of type `(url: string) => Promise<unknown>` (Task 5 shape).
- Produces:
  ```ts
  // scrapers/types.ts
  type ScrapeScope = 'all' | 'open' | 'archive';
  interface ScrapeProgress {
    source: string; job: string;             // e.g. "open-quotation"
    jobsCompleted: number; jobsTotal: number;
    currentPage: number; lastPage: number;
  }
  interface ScraperAdapter {
    name: string;
    scrape(
      scope: ScrapeScope,
      hooks: {
        onProgress: (p: ScrapeProgress) => void;
        onBatch: (tenders: Tender[]) => Promise<void>;  // called once per fetched page
      },
    ): Promise<void>;  // rejects if any job fails after retries
  }
  ```
  - `MyProcurementAdapter` class: `constructor(fetcher: (url: string) => Promise<unknown>)`, `name === 'myprocurement'`.
  - Exported `MYPROCUREMENT_JOBS` const with the 6 `(status, procurementType, type, category)` combinations.

- [ ] **Step 1: Write the failing test**

`backend/test/adapter.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { Tender } from '@tms/shared';
import { MyProcurementAdapter, MYPROCUREMENT_JOBS } from '../src/scrapers/myprocurement/adapter.js';

// Minimal parseable card generator (same markup shape the parser understands).
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
  it('defines exactly the 6 verified type/category combinations', () => {
    expect(MYPROCUREMENT_JOBS).toEqual([
      { status: 'open', procurementType: 'quotation', type: 'advertisements', category: 'quotation' },
      { status: 'open', procurementType: 'tender', type: 'advertisements', category: 'tender' },
      { status: 'open', procurementType: 'requisition', type: 'advertisements', category: 'requisition' },
      { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'advertisement-quotation' },
      { status: 'closed', procurementType: 'tender', type: 'archive', category: 'advertisement-tender' },
      { status: 'closed', procurementType: 'requisition', type: 'archive', category: 'advertisement-requisition' },
    ]);
  });
});

describe('MyProcurementAdapter', () => {
  it('scope=open crawls only the 3 advertisement jobs, every page, with explicit params', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      return pageResponse([page * 10 + 1], 2); // 2 pages per job
    });
    const adapter = new MyProcurementAdapter(fetcher);
    const batches: Tender[][] = [];
    await adapter.scrape('open', { onProgress: () => {}, onBatch: async (t) => { batches.push(t); } });

    expect(urls).toHaveLength(6); // 3 jobs x 2 pages
    for (const url of urls) {
      const params = new URL(url).searchParams;
      expect(params.get('itemsPerPage')).toBe('100');
      expect(params.get('type')).toBe('advertisements');
      expect(['quotation', 'tender', 'requisition']).toContain(params.get('category'));
    }
    expect(batches).toHaveLength(6);
    expect(batches.flat().every((t) => t.status === 'open')).toBe(true);
  });

  it('scope=archive crawls the 3 archive jobs with advertisement-* categories', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { urls.push(url); return pageResponse([1], 1); });
    const adapter = new MyProcurementAdapter(fetcher);
    await adapter.scrape('archive', { onProgress: () => {}, onBatch: async () => {} });
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      const params = new URL(url).searchParams;
      expect(params.get('type')).toBe('archive');
      expect(params.get('category')).toMatch(/^advertisement-(quotation|tender|requisition)$/);
    }
  });

  it('scope=all runs all 6 jobs and tags status/procurementType per job', async () => {
    const fetcher = vi.fn(async (url: string) => pageResponse([Number(new URL(url).searchParams.get('page'))], 1));
    const adapter = new MyProcurementAdapter(fetcher);
    const all: Tender[] = [];
    await adapter.scrape('all', { onProgress: () => {}, onBatch: async (t) => { all.push(...t); } });
    expect(all.filter((t) => t.status === 'open')).toHaveLength(3);
    expect(all.filter((t) => t.status === 'closed')).toHaveLength(3);
  });

  it('reports progress with job name, page counts and job totals', async () => {
    const fetcher = vi.fn(async () => pageResponse([1], 2));
    const adapter = new MyProcurementAdapter(fetcher);
    const progress: unknown[] = [];
    await adapter.scrape('archive', { onProgress: (p) => progress.push({ ...p }), onBatch: async () => {} });
    expect(progress[0]).toEqual({
      source: 'myprocurement', job: 'closed-quotation',
      jobsCompleted: 0, jobsTotal: 3, currentPage: 1, lastPage: 2,
    });
  });

  it('rejects when the fetcher exhausts retries, without calling onBatch for the failed page', async () => {
    const fetcher = vi.fn(async () => { throw new Error('fetch failed after 3 attempts: x'); });
    const adapter = new MyProcurementAdapter(fetcher);
    const onBatch = vi.fn(async () => {});
    await expect(adapter.scrape('open', { onProgress: () => {}, onBatch })).rejects.toThrow('fetch failed');
    expect(onBatch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`backend/src/scrapers/types.ts`:
```ts
import type { Tender } from '@tms/shared';

export type ScrapeScope = 'all' | 'open' | 'archive';

export interface ScrapeProgress {
  source: string;
  job: string;
  jobsCompleted: number;
  jobsTotal: number;
  currentPage: number;
  lastPage: number;
}

export interface ScrapeHooks {
  onProgress: (p: ScrapeProgress) => void;
  onBatch: (tenders: Tender[]) => Promise<void>;
}

export interface ScraperAdapter {
  name: string;
  scrape(scope: ScrapeScope, hooks: ScrapeHooks): Promise<void>;
}
```

`backend/src/scrapers/myprocurement/adapter.ts`:
```ts
import { z } from 'zod';
import type { ScrapeHooks, ScrapeScope, ScraperAdapter } from '../types.js';
import { parseListingHtml } from './parseListing.js';

const BASE_URL = 'https://myprocurement.treasury.gov.my/procurements/fetch';
const ITEMS_PER_PAGE = 100;

export const MYPROCUREMENT_JOBS = [
  { status: 'open', procurementType: 'quotation', type: 'advertisements', category: 'quotation' },
  { status: 'open', procurementType: 'tender', type: 'advertisements', category: 'tender' },
  { status: 'open', procurementType: 'requisition', type: 'advertisements', category: 'requisition' },
  { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'advertisement-quotation' },
  { status: 'closed', procurementType: 'tender', type: 'archive', category: 'advertisement-tender' },
  { status: 'closed', procurementType: 'requisition', type: 'archive', category: 'advertisement-requisition' },
] as const;

const ListingResponse = z.object({ html: z.string(), lastPage: z.number().int().min(1) });

export class MyProcurementAdapter implements ScraperAdapter {
  readonly name = 'myprocurement';

  constructor(private readonly fetcher: (url: string) => Promise<unknown>) {}

  async scrape(scope: ScrapeScope, hooks: ScrapeHooks): Promise<void> {
    const jobs = MYPROCUREMENT_JOBS.filter((j) =>
      scope === 'all' ? true : scope === 'open' ? j.status === 'open' : j.status === 'closed',
    );

    for (const [jobIndex, job] of jobs.entries()) {
      const jobName = `${job.status}-${job.procurementType}`;
      let page = 1;
      let lastPage = 1;
      do {
        const url = `${BASE_URL}?page=${page}&itemsPerPage=${ITEMS_PER_PAGE}&type=${job.type}&category=${job.category}`;
        const body = ListingResponse.parse(await this.fetcher(url));
        lastPage = body.lastPage;
        hooks.onProgress({
          source: this.name,
          job: jobName,
          jobsCompleted: jobIndex,
          jobsTotal: jobs.length,
          currentPage: page,
          lastPage,
        });
        const tenders = parseListingHtml(body.html, {
          status: job.status,
          procurementType: job.procurementType,
        });
        await hooks.onBatch(tenders);
        page += 1;
      } while (page <= lastPage);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w backend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrapers backend/test/adapter.test.ts
git commit -m "feat(backend): MyProcurement adapter crawling all 6 type/category jobs"
```

---

### Task 7: Tender repository (JSON files, atomic writes, upsert, meta)

**Files:**
- Create: `backend/src/storage/repository.ts`
- Test: `backend/test/repository.test.ts`

**Interfaces:**
- Consumes: `Tender` (Task 2).
- Produces:
  ```ts
  interface SourceMeta { lastScrapedAt: string | null; lastArchiveBackfillAt: string | null; total: number }
  class TenderRepository {
    constructor(dataDir: string)
    async load(): Promise<void>                       // reads all data/<source>/tenders.json into memory
    getAll(): Tender[]                                // all sources, in-memory
    hasSource(source: string): boolean                // true if source dir was loaded with data file present
    upsertMany(source: string, tenders: Tender[]): void   // in-memory merge by id
    async flush(source: string): Promise<void>        // atomic write tenders.json + meta.total
    getMeta(source: string): SourceMeta
    async setMeta(source: string, patch: Partial<SourceMeta>): Promise<void>  // merges + atomic write
  }
  ```

- [ ] **Step 1: Write the failing test**

`backend/test/repository.test.ts`:
```ts
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Tender } from '@tms/shared';
import { TenderRepository } from '../src/storage/repository.js';

function makeTender(overrides: Partial<Tender> = {}): Tender {
  return {
    id: 'myprocurement:1', source: 'myprocurement', sourceId: '1',
    referenceNo: 'REF/1', dedupKey: 'REF/1', title: 'T1',
    sourceUrl: 'https://example.com/1', status: 'open', procurementType: 'quotation',
    ministry: null, agency: null, category: null, fieldCodes: [],
    advertisedDate: null, closingDate: null, indicativePrice: null,
    currency: 'MYR', events: [], raw: {}, scrapedAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  };
}

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tms-repo-'));
  return { dir, repo: new TenderRepository(dir) };
}

describe('TenderRepository', () => {
  it('starts empty and reports missing sources', async () => {
    const { repo } = freshRepo();
    await repo.load();
    expect(repo.getAll()).toEqual([]);
    expect(repo.hasSource('myprocurement')).toBe(false);
  });

  it('upserts by id: new records added, existing replaced, delisted kept', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.upsertMany('myprocurement', [makeTender(), makeTender({ id: 'myprocurement:2', sourceId: '2', title: 'T2' })]);
    // second scrape: id 1 updated, id 2 absent (delisted), id 3 new
    repo.upsertMany('myprocurement', [makeTender({ title: 'T1-updated' }), makeTender({ id: 'myprocurement:3', sourceId: '3', title: 'T3' })]);
    const titles = repo.getAll().map((t) => t.title).sort();
    expect(titles).toEqual(['T1-updated', 'T2', 'T3']);
  });

  it('flush persists atomically and load restores across instances', async () => {
    const { dir, repo } = freshRepo();
    await repo.load();
    repo.upsertMany('myprocurement', [makeTender()]);
    await repo.flush('myprocurement');

    expect(readdirSync(join(dir, 'myprocurement'))).toContain('tenders.json'); // no .tmp left behind
    const onDisk = JSON.parse(readFileSync(join(dir, 'myprocurement', 'tenders.json'), 'utf8'));
    expect(onDisk).toHaveLength(1);

    const repo2 = new TenderRepository(dir);
    await repo2.load();
    expect(repo2.hasSource('myprocurement')).toBe(true);
    expect(repo2.getAll()).toHaveLength(1);
    expect(repo2.getMeta('myprocurement').total).toBe(1);
  });

  it('meta defaults, patches, and persists', async () => {
    const { dir, repo } = freshRepo();
    await repo.load();
    expect(repo.getMeta('myprocurement')).toEqual({ lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 });
    await repo.setMeta('myprocurement', { lastArchiveBackfillAt: '2026-07-07T00:00:00.000Z' });
    const repo2 = new TenderRepository(dir);
    await repo2.load();
    expect(repo2.getMeta('myprocurement').lastArchiveBackfillAt).toBe('2026-07-07T00:00:00.000Z');
  });

  it('handles large batch flush (archive scale) without quadratic behavior', async () => {
    const { repo } = freshRepo();
    await repo.load();
    const big = Array.from({ length: 20000 }, (_, i) =>
      makeTender({ id: `myprocurement:${i}`, sourceId: String(i), dedupKey: `REF/${i}` }));
    const start = Date.now();
    repo.upsertMany('myprocurement', big);
    await repo.flush('myprocurement');
    expect(Date.now() - start).toBeLessThan(5000);
    expect(repo.getAll()).toHaveLength(20000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`backend/src/storage/repository.ts`:
```ts
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tender } from '@tms/shared';

export interface SourceMeta {
  lastScrapedAt: string | null;
  lastArchiveBackfillAt: string | null;
  total: number;
}

const DEFAULT_META: SourceMeta = { lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 };

export class TenderRepository {
  // source -> (id -> Tender): Map keeps upserts O(1) even at archive scale
  private readonly bySource = new Map<string, Map<string, Tender>>();
  private readonly metaBySource = new Map<string, SourceMeta>();
  private readonly loadedSources = new Set<string>();

  constructor(private readonly dataDir: string) {}

  async load(): Promise<void> {
    let sources: string[] = [];
    try {
      sources = (await readdir(this.dataDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return; // data dir doesn't exist yet
    }
    for (const source of sources) {
      try {
        const tenders = JSON.parse(await readFile(join(this.dataDir, source, 'tenders.json'), 'utf8')) as Tender[];
        this.bySource.set(source, new Map(tenders.map((t) => [t.id, t])));
        this.loadedSources.add(source);
      } catch {
        /* no tenders.json for this source */
      }
      try {
        const meta = JSON.parse(await readFile(join(this.dataDir, source, 'meta.json'), 'utf8')) as SourceMeta;
        this.metaBySource.set(source, { ...DEFAULT_META, ...meta });
      } catch {
        /* no meta.json */
      }
    }
  }

  getAll(): Tender[] {
    return [...this.bySource.values()].flatMap((m) => [...m.values()]);
  }

  hasSource(source: string): boolean {
    return this.loadedSources.has(source);
  }

  upsertMany(source: string, tenders: Tender[]): void {
    let map = this.bySource.get(source);
    if (!map) {
      map = new Map();
      this.bySource.set(source, map);
    }
    for (const t of tenders) map.set(t.id, t);
  }

  async flush(source: string): Promise<void> {
    const map = this.bySource.get(source) ?? new Map<string, Tender>();
    const dir = join(this.dataDir, source);
    await mkdir(dir, { recursive: true });
    await atomicWrite(join(dir, 'tenders.json'), JSON.stringify([...map.values()]));
    this.loadedSources.add(source);
    await this.setMeta(source, { total: map.size });
  }

  getMeta(source: string): SourceMeta {
    return this.metaBySource.get(source) ?? { ...DEFAULT_META };
  }

  async setMeta(source: string, patch: Partial<SourceMeta>): Promise<void> {
    const merged = { ...this.getMeta(source), ...patch };
    this.metaBySource.set(source, merged);
    const dir = join(this.dataDir, source);
    await mkdir(dir, { recursive: true });
    await atomicWrite(join(dir, 'meta.json'), JSON.stringify(merged, null, 2));
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w backend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/storage backend/test/repository.test.ts
git commit -m "feat(backend): JSON-file tender repository with atomic writes and upsert"
```

---

### Task 8: Query layer (dedup, filter, sort, paginate, facets)

**Files:**
- Create: `backend/src/query/tenders.ts`
- Test: `backend/test/query.test.ts`

**Interfaces:**
- Consumes: `Tender` (Task 2).
- Produces:
  ```ts
  interface TenderQuery {
    search?: string; ministry?: string; agency?: string; category?: string;
    source?: string; status?: 'open' | 'closed';
    procurementType?: 'quotation' | 'tender' | 'requisition';
    sortBy?: 'advertisedDate' | 'closingDate' | 'indicativePrice';
    sortOrder?: 'asc' | 'desc';
    page?: number; pageSize?: number;   // defaults 1, 20; pageSize capped at 100
  }
  interface TenderPage { items: Tender[]; total: number; page: number; pageSize: number }
  interface Facets { ministries: string[]; agencies: string[]; categories: string[]; sources: string[]; procurementTypes: string[] }
  function dedupeTenders(tenders: Tender[]): Tender[]
  function queryTenders(tenders: Tender[], q: TenderQuery): TenderPage   // dedupes internally
  function buildFacets(tenders: Tender[]): Facets                        // sorted, distinct, nulls omitted
  function findById(tenders: Tender[], id: string): { tender: Tender; alsoAvailableFrom: Tender[] } | null
  ```

- [ ] **Step 1: Write the failing test**

`backend/test/query.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Tender } from '@tms/shared';
import { buildFacets, dedupeTenders, findById, queryTenders } from '../src/query/tenders.js';

let seq = 0;
function t(overrides: Partial<Tender> = {}): Tender {
  seq += 1;
  return {
    id: `myprocurement:${seq}`, source: 'myprocurement', sourceId: String(seq),
    referenceNo: `REF/${seq}`, dedupKey: `REF/${seq}`, title: `TENDER ${seq}`,
    sourceUrl: `https://example.com/${seq}`, status: 'open', procurementType: 'quotation',
    ministry: 'KEMENTERIAN A', agency: 'AGENSI A', category: 'Bekalan', fieldCodes: [],
    advertisedDate: '2026-07-01', closingDate: '2026-07-15', indicativePrice: 1000,
    currency: 'MYR', events: [], raw: {}, scrapedAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('dedupeTenders', () => {
  it('keeps one canonical record per dedupKey, preferring most non-null fields', () => {
    const sparse = t({ id: 'src2:1', source: 'src2', dedupKey: 'SAME', ministry: null, agency: null });
    const rich = t({ dedupKey: 'SAME' });
    expect(dedupeTenders([sparse, rich])).toEqual([rich]);
  });
  it('ties broken by newest scrapedAt', () => {
    const older = t({ dedupKey: 'SAME', scrapedAt: '2026-07-01T00:00:00.000Z' });
    const newer = t({ dedupKey: 'SAME', scrapedAt: '2026-07-07T00:00:00.000Z' });
    expect(dedupeTenders([older, newer])).toEqual([newer]);
  });
  it('never merges distinct dedupKeys', () => {
    expect(dedupeTenders([t(), t()])).toHaveLength(2);
  });
});

describe('queryTenders', () => {
  it('searches title and referenceNo case-insensitively', () => {
    const data = [t({ title: 'MEMBINA BUMBUNG' }), t({ referenceNo: 'KP/STRIDE/26', dedupKey: 'KP/STRIDE/26' }), t()];
    expect(queryTenders(data, { search: 'bumbung' }).items).toHaveLength(1);
    expect(queryTenders(data, { search: 'stride' }).items).toHaveLength(1);
  });

  it('filters by every supported field', () => {
    const data = [
      t({ ministry: 'KEMENTERIAN B' }),
      t({ status: 'closed' }),
      t({ procurementType: 'tender' }),
      t({ source: 'other', id: 'other:1' }),
      t({ agency: 'AGENSI B' }),
      t({ category: 'Kerja' }),
    ];
    expect(queryTenders(data, { ministry: 'KEMENTERIAN B' }).total).toBe(1);
    expect(queryTenders(data, { status: 'closed' }).total).toBe(1);
    expect(queryTenders(data, { procurementType: 'tender' }).total).toBe(1);
    expect(queryTenders(data, { source: 'other' }).total).toBe(1);
    expect(queryTenders(data, { agency: 'AGENSI B' }).total).toBe(1);
    expect(queryTenders(data, { category: 'Kerja' }).total).toBe(1);
  });

  it('sorts by price desc with nulls last, paginates with total', () => {
    const data = [t({ indicativePrice: 5 }), t({ indicativePrice: null }), t({ indicativePrice: 99 })];
    const page = queryTenders(data, { sortBy: 'indicativePrice', sortOrder: 'desc', page: 1, pageSize: 2 });
    expect(page.items.map((x) => x.indicativePrice)).toEqual([99, 5]);
    expect(page.total).toBe(3);
    const page2 = queryTenders(data, { sortBy: 'indicativePrice', sortOrder: 'desc', page: 2, pageSize: 2 });
    expect(page2.items.map((x) => x.indicativePrice)).toEqual([null]);
  });

  it('defaults: sorted by advertisedDate desc, page 1, pageSize 20, pageSize capped at 100', () => {
    const data = [t({ advertisedDate: '2026-01-01' }), t({ advertisedDate: '2026-06-01' })];
    const page = queryTenders(data, {});
    expect(page.items[0]!.advertisedDate).toBe('2026-06-01');
    expect(page.pageSize).toBe(20);
    expect(queryTenders(data, { pageSize: 5000 }).pageSize).toBe(100);
  });
});

describe('buildFacets', () => {
  it('returns sorted distinct values, omitting nulls', () => {
    const data = [
      t({ ministry: 'Z', agency: null, category: 'Kerja', procurementType: 'tender' }),
      t({ ministry: 'A' }),
      t({ ministry: 'A' }),
    ];
    const f = buildFacets(data);
    expect(f.ministries).toEqual(['A', 'Z']);
    expect(f.agencies).toEqual(['AGENSI A']);
    expect(f.sources).toEqual(['myprocurement']);
    expect(f.procurementTypes).toEqual(['quotation', 'tender']);
  });
});

describe('findById', () => {
  it('returns the tender plus other-source records sharing its dedupKey', () => {
    const a = t({ dedupKey: 'SAME' });
    const b = t({ id: 'other:9', source: 'other', dedupKey: 'SAME' });
    const res = findById([a, b], a.id);
    expect(res?.tender.id).toBe(a.id);
    expect(res?.alsoAvailableFrom.map((x) => x.id)).toEqual(['other:9']);
  });
  it('returns null for unknown id', () => {
    expect(findById([t()], 'nope:1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`backend/src/query/tenders.ts`:
```ts
import type { Tender } from '@tms/shared';

export interface TenderQuery {
  search?: string;
  ministry?: string;
  agency?: string;
  category?: string;
  source?: string;
  status?: 'open' | 'closed';
  procurementType?: 'quotation' | 'tender' | 'requisition';
  sortBy?: 'advertisedDate' | 'closingDate' | 'indicativePrice';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface TenderPage {
  items: Tender[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Facets {
  ministries: string[];
  agencies: string[];
  categories: string[];
  sources: string[];
  procurementTypes: string[];
}

const MAX_PAGE_SIZE = 100;

function completeness(t: Tender): number {
  return [t.ministry, t.agency, t.category, t.advertisedDate, t.closingDate, t.indicativePrice]
    .filter((v) => v !== null).length + t.events.length + t.fieldCodes.length;
}

export function dedupeTenders(tenders: Tender[]): Tender[] {
  const byKey = new Map<string, Tender>();
  for (const t of tenders) {
    const existing = byKey.get(t.dedupKey);
    if (!existing) {
      byKey.set(t.dedupKey, t);
      continue;
    }
    const cNew = completeness(t);
    const cOld = completeness(existing);
    if (cNew > cOld || (cNew === cOld && t.scrapedAt > existing.scrapedAt)) {
      byKey.set(t.dedupKey, t);
    }
  }
  return [...byKey.values()];
}

export function queryTenders(tenders: Tender[], q: TenderQuery): TenderPage {
  let items = dedupeTenders(tenders);

  if (q.search) {
    const needle = q.search.toLowerCase();
    items = items.filter(
      (t) => t.title.toLowerCase().includes(needle) || t.referenceNo.toLowerCase().includes(needle),
    );
  }
  if (q.ministry) items = items.filter((t) => t.ministry === q.ministry);
  if (q.agency) items = items.filter((t) => t.agency === q.agency);
  if (q.category) items = items.filter((t) => t.category === q.category);
  if (q.source) items = items.filter((t) => t.source === q.source);
  if (q.status) items = items.filter((t) => t.status === q.status);
  if (q.procurementType) items = items.filter((t) => t.procurementType === q.procurementType);

  const sortBy = q.sortBy ?? 'advertisedDate';
  const dir = (q.sortOrder ?? 'desc') === 'asc' ? 1 : -1;
  items.sort((a, b) => {
    const av = a[sortBy];
    const bv = b[sortBy];
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // nulls last regardless of direction
    if (bv === null) return -1;
    return av < bv ? -dir : av > bv ? dir : 0;
  });

  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, q.pageSize ?? 20));
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    total: items.length,
    page,
    pageSize,
  };
}

export function buildFacets(tenders: Tender[]): Facets {
  const deduped = dedupeTenders(tenders);
  const distinct = (vals: Array<string | null>) =>
    [...new Set(vals.filter((v): v is string => v !== null))].sort();
  return {
    ministries: distinct(deduped.map((t) => t.ministry)),
    agencies: distinct(deduped.map((t) => t.agency)),
    categories: distinct(deduped.map((t) => t.category)),
    sources: distinct(deduped.map((t) => t.source)),
    procurementTypes: distinct(deduped.map((t) => t.procurementType)),
  };
}

export function findById(
  tenders: Tender[],
  id: string,
): { tender: Tender; alsoAvailableFrom: Tender[] } | null {
  const tender = tenders.find((t) => t.id === id);
  if (!tender) return null;
  return {
    tender,
    alsoAvailableFrom: tenders.filter((t) => t.dedupKey === tender.dedupKey && t.id !== tender.id),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w backend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/query backend/test/query.test.ts
git commit -m "feat(backend): query layer with cross-source dedup, filters, facets"
```

---

### Task 9: Scrape manager (orchestration + status)

**Files:**
- Create: `backend/src/scrape/manager.ts`
- Test: `backend/test/manager.test.ts`

**Interfaces:**
- Consumes: `ScraperAdapter`, `ScrapeScope`, `ScrapeProgress` (Task 6); `TenderRepository` (Task 7).
- Produces:
  ```ts
  interface ScrapeStatus {
    state: 'idle' | 'running' | 'done' | 'failed';
    source?: string; job?: string;
    jobsCompleted?: number; jobsTotal?: number;
    currentPage?: number; lastPage?: number;
    error?: string;
  }
  class ScrapeManager {
    constructor(adapters: ScraperAdapter[], repo: TenderRepository, opts?: { flushEveryPages?: number; now?: () => string })
    status(): ScrapeStatus
    start(scope: ScrapeScope): boolean        // false if already running; runs async in background
    async runToCompletion(scope: ScrapeScope): Promise<void>  // awaited variant used by start() and tests
  }
  ```
  Behavior: batches upserted per page; `flush` every `flushEveryPages` (default 10) pages and at each job end; on full success sets `lastScrapedAt` (and `lastArchiveBackfillAt` when scope included archive); on error sets state `failed` with message, previously flushed data intact.

- [ ] **Step 1: Write the failing test**

`backend/test/manager.test.ts`:
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Tender } from '@tms/shared';
import type { ScrapeHooks, ScrapeScope, ScraperAdapter } from '../src/scrapers/types.js';
import { TenderRepository } from '../src/storage/repository.js';
import { ScrapeManager } from '../src/scrape/manager.js';

const NOW = () => '2026-07-07T12:00:00.000Z';

function makeTender(id: number): Tender {
  return {
    id: `fake:${id}`, source: 'fake', sourceId: String(id),
    referenceNo: `REF/${id}`, dedupKey: `REF/${id}`, title: `T${id}`,
    sourceUrl: `https://example.com/${id}`, status: 'open', procurementType: 'quotation',
    ministry: null, agency: null, category: null, fieldCodes: [],
    advertisedDate: null, closingDate: null, indicativePrice: null,
    currency: 'MYR', events: [], raw: {}, scrapedAt: NOW(),
  };
}

function fakeAdapter(behavior: (scope: ScrapeScope, hooks: ScrapeHooks) => Promise<void>): ScraperAdapter {
  return { name: 'fake', scrape: behavior };
}

async function freshRepo() {
  const repo = new TenderRepository(mkdtempSync(join(tmpdir(), 'tms-mgr-')));
  await repo.load();
  return repo;
}

describe('ScrapeManager', () => {
  it('starts idle', async () => {
    const mgr = new ScrapeManager([], await freshRepo(), { now: NOW });
    expect(mgr.status()).toEqual({ state: 'idle' });
  });

  it('runs a scrape: upserts batches, reports done, stamps lastScrapedAt', async () => {
    const repo = await freshRepo();
    const adapter = fakeAdapter(async (_scope, hooks) => {
      hooks.onProgress({ source: 'fake', job: 'open-quotation', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1 });
      await hooks.onBatch([makeTender(1), makeTender(2)]);
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('open');
    expect(mgr.status().state).toBe('done');
    expect(repo.getAll()).toHaveLength(2);
    expect(repo.getMeta('fake').lastScrapedAt).toBe(NOW());
    expect(repo.getMeta('fake').lastArchiveBackfillAt).toBeNull();
  });

  it('stamps lastArchiveBackfillAt when scope covers archive', async () => {
    const repo = await freshRepo();
    const adapter = fakeAdapter(async () => {});
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('all');
    expect(repo.getMeta('fake').lastArchiveBackfillAt).toBe(NOW());
  });

  it('exposes live progress while running', async () => {
    const repo = await freshRepo();
    let capturedMid: unknown;
    const adapter = fakeAdapter(async (_s, hooks) => {
      hooks.onProgress({ source: 'fake', job: 'open-tender', jobsCompleted: 1, jobsTotal: 3, currentPage: 12, lastPage: 96 });
      capturedMid = mgr.status();
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('open');
    expect(capturedMid).toEqual({
      state: 'running', source: 'fake', job: 'open-tender',
      jobsCompleted: 1, jobsTotal: 3, currentPage: 12, lastPage: 96,
    });
  });

  it('rejects concurrent starts', async () => {
    const repo = await freshRepo();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const adapter = fakeAdapter(async () => gate);
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    expect(mgr.start('open')).toBe(true);
    expect(mgr.start('open')).toBe(false); // already running
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(mgr.status().state).toBe('done');
  });

  it('sets failed state with error message; keeps previously flushed batches', async () => {
    const repo = await freshRepo();
    const adapter = fakeAdapter(async (_s, hooks) => {
      await hooks.onBatch([makeTender(1)]);
      throw new Error('fetch failed after 3 attempts: url');
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW, flushEveryPages: 1 });
    await mgr.runToCompletion('open');
    expect(mgr.status().state).toBe('failed');
    expect(mgr.status().error).toContain('fetch failed');
    expect(repo.getAll()).toHaveLength(1); // flushed page survived
    expect(repo.getMeta('fake').lastScrapedAt).toBeNull(); // not stamped on failure
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`backend/src/scrape/manager.ts`:
```ts
import type { ScrapeScope, ScraperAdapter } from '../scrapers/types.js';
import type { TenderRepository } from '../storage/repository.js';

export interface ScrapeStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  source?: string;
  job?: string;
  jobsCompleted?: number;
  jobsTotal?: number;
  currentPage?: number;
  lastPage?: number;
  error?: string;
}

export class ScrapeManager {
  private current: ScrapeStatus = { state: 'idle' };
  private running = false;

  constructor(
    private readonly adapters: ScraperAdapter[],
    private readonly repo: TenderRepository,
    private readonly opts: { flushEveryPages?: number; now?: () => string } = {},
  ) {}

  status(): ScrapeStatus {
    return { ...this.current };
  }

  start(scope: ScrapeScope): boolean {
    if (this.running) return false;
    void this.runToCompletion(scope);
    return true;
  }

  async runToCompletion(scope: ScrapeScope): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.current = { state: 'running' };
    const now = this.opts.now ?? (() => new Date().toISOString());
    const flushEvery = this.opts.flushEveryPages ?? 10;

    try {
      for (const adapter of this.adapters) {
        let pagesSinceFlush = 0;
        await adapter.scrape(scope, {
          onProgress: (p) => {
            this.current = { state: 'running', ...p };
          },
          onBatch: async (tenders) => {
            this.repo.upsertMany(adapter.name, tenders);
            pagesSinceFlush += 1;
            if (pagesSinceFlush >= flushEvery) {
              await this.repo.flush(adapter.name);
              pagesSinceFlush = 0;
            }
          },
        });
        await this.repo.flush(adapter.name);
        const stamp: Parameters<TenderRepository['setMeta']>[1] = { lastScrapedAt: now() };
        if (scope === 'all' || scope === 'archive') stamp.lastArchiveBackfillAt = now();
        await this.repo.setMeta(adapter.name, stamp);
      }
      this.current = { state: 'done' };
    } catch (err) {
      this.current = { state: 'failed', error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.running = false;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w backend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrape backend/test/manager.test.ts
git commit -m "feat(backend): scrape manager with progress, batching, failure isolation"
```

---

### Task 10: Express API + bootstrap

**Files:**
- Create: `backend/src/api/app.ts`, `backend/src/index.ts`
- Test: `backend/test/app.test.ts`

**Interfaces:**
- Consumes: `TenderRepository` (Task 7), query functions (Task 8), `ScrapeManager` (Task 9).
- Produces: `createApp(deps: { repo: TenderRepository; manager: ScrapeManager }): Express` with routes:
  - `GET /api/tenders` → `TenderPage` (query params per `TenderQuery`)
  - `GET /api/tenders/facets` → `Facets`
  - `GET /api/tenders/:id` → `{ tender, alsoAvailableFrom }` or 404 `{ error }`
  - `POST /api/scrape` → 202 `{ started: true }` or 409 `{ error }`
  - `GET /api/scrape/status` → `ScrapeStatus`
  - `GET /api/health` → `{ ok: true }`

- [ ] **Step 1: Write the failing test**

`backend/test/app.test.ts`:
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Tender } from '@tms/shared';
import { createApp } from '../src/api/app.js';
import { ScrapeManager } from '../src/scrape/manager.js';
import type { ScrapeHooks } from '../src/scrapers/types.js';
import { TenderRepository } from '../src/storage/repository.js';

let seq = 0;
function t(overrides: Partial<Tender> = {}): Tender {
  seq += 1;
  return {
    id: `myprocurement:${seq}`, source: 'myprocurement', sourceId: String(seq),
    referenceNo: `REF/${seq}`, dedupKey: `REF/${seq}`, title: `TENDER ${seq}`,
    sourceUrl: `https://example.com/${seq}`, status: 'open', procurementType: 'quotation',
    ministry: 'KEMENTERIAN A', agency: null, category: null, fieldCodes: [],
    advertisedDate: '2026-07-01', closingDate: null, indicativePrice: null,
    currency: 'MYR', events: [], raw: {}, scrapedAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('API', () => {
  let repo: TenderRepository;
  let manager: ScrapeManager;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    repo = new TenderRepository(mkdtempSync(join(tmpdir(), 'tms-app-')));
    await repo.load();
    manager = new ScrapeManager([], repo);
    app = createApp({ repo, manager });
  });

  it('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api/tenders returns paginated, filterable results', async () => {
    repo.upsertMany('myprocurement', [t({ title: 'BUMBUNG GELANGGANG' }), t({ status: 'closed' }), t()]);
    const all = await request(app).get('/api/tenders');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.page).toBe(1);

    const filtered = await request(app).get('/api/tenders?status=closed');
    expect(filtered.body.total).toBe(1);

    const searched = await request(app).get('/api/tenders?search=bumbung');
    expect(searched.body.total).toBe(1);
  });

  it('GET /api/tenders rejects invalid query params with 400', async () => {
    const res = await request(app).get('/api/tenders?status=maybe');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('GET /api/tenders/facets returns distinct values', async () => {
    repo.upsertMany('myprocurement', [t(), t({ ministry: 'KEMENTERIAN B' })]);
    const res = await request(app).get('/api/tenders/facets');
    expect(res.status).toBe(200);
    expect(res.body.ministries).toEqual(['KEMENTERIAN A', 'KEMENTERIAN B']);
  });

  it('GET /api/tenders/:id returns tender with alsoAvailableFrom; 404 when missing', async () => {
    const a = t({ dedupKey: 'SAME' });
    const b = t({ id: 'other:1', source: 'other', dedupKey: 'SAME' });
    repo.upsertMany('myprocurement', [a]);
    repo.upsertMany('other', [b]);
    const res = await request(app).get(`/api/tenders/${encodeURIComponent(a.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.tender.id).toBe(a.id);
    expect(res.body.alsoAvailableFrom).toHaveLength(1);

    const missing = await request(app).get('/api/tenders/nope:1');
    expect(missing.status).toBe(404);
  });

  it('POST /api/scrape starts an open-scope scrape (202) and 409s while running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let receivedScope: string | undefined;
    const blockingManager = new ScrapeManager(
      [{ name: 'fake', scrape: async (scope: string, _h: ScrapeHooks) => { receivedScope = scope; await gate; } }],
      repo,
    );
    const app2 = createApp({ repo, manager: blockingManager });

    const first = await request(app2).post('/api/scrape');
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ started: true });
    expect(receivedScope).toBe('open');

    const second = await request(app2).post('/api/scrape');
    expect(second.status).toBe(409);

    const status = await request(app2).get('/api/scrape/status');
    expect(status.body.state).toBe('running');
    release();
  });

  it('GET /api/scrape/status is idle initially', async () => {
    const res = await request(app).get('/api/scrape/status');
    expect(res.body).toEqual({ state: 'idle' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`backend/src/api/app.ts`:
```ts
import express from 'express';
import { z } from 'zod';
import type { ScrapeManager } from '../scrape/manager.js';
import type { TenderRepository } from '../storage/repository.js';
import { buildFacets, findById, queryTenders } from '../query/tenders.js';

const QuerySchema = z.object({
  search: z.string().optional(),
  ministry: z.string().optional(),
  agency: z.string().optional(),
  category: z.string().optional(),
  source: z.string().optional(),
  status: z.enum(['open', 'closed']).optional(),
  procurementType: z.enum(['quotation', 'tender', 'requisition']).optional(),
  sortBy: z.enum(['advertisedDate', 'closingDate', 'indicativePrice']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
});

export function createApp(deps: { repo: TenderRepository; manager: ScrapeManager }) {
  const app = express();

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/tenders/facets', (_req, res) => {
    res.json(buildFacets(deps.repo.getAll()));
  });

  app.get('/api/tenders/:id', (req, res) => {
    const found = findById(deps.repo.getAll(), req.params.id);
    if (!found) return res.status(404).json({ error: 'tender not found' });
    res.json(found);
  });

  app.get('/api/tenders', (req, res) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.json(queryTenders(deps.repo.getAll(), parsed.data));
  });

  app.post('/api/scrape', (_req, res) => {
    if (!deps.manager.start('open')) {
      return res.status(409).json({ error: 'scrape already running' });
    }
    res.status(202).json({ started: true });
  });

  app.get('/api/scrape/status', (_req, res) => {
    res.json(deps.manager.status());
  });

  return app;
}
```

`backend/src/index.ts` (bootstrap — excluded from coverage, wiring only):
```ts
import { MyProcurementAdapter } from './scrapers/myprocurement/adapter.js';
import { createPoliteFetcher } from './http/politeFetch.js';
import { TenderRepository } from './storage/repository.js';
import { ScrapeManager } from './scrape/manager.js';
import { createApp } from './api/app.js';

const PORT = Number(process.env.PORT) || 3001;
const DATA_DIR = process.env.DATA_DIR || new URL('../data', import.meta.url).pathname;

async function main() {
  const repo = new TenderRepository(DATA_DIR);
  await repo.load();

  const adapters = [new MyProcurementAdapter(createPoliteFetcher())];
  const manager = new ScrapeManager(adapters, repo);

  // Startup scrape policy (spec: Startup section):
  // - no data at all           -> full scrape (open + archive backfill)
  // - data but backfill unset  -> resume archive backfill only
  // - otherwise                -> nothing
  const needsFull = adapters.some((a) => !repo.hasSource(a.name));
  const needsBackfill = adapters.some((a) => repo.getMeta(a.name).lastArchiveBackfillAt === null);
  if (needsFull) {
    console.log('[startup] no data found — starting full scrape (open + archive backfill)');
    manager.start('all');
  } else if (needsBackfill) {
    console.log('[startup] archive backfill incomplete — resuming');
    manager.start('archive');
  }

  createApp({ repo, manager }).listen(PORT, () => {
    console.log(`backend listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w backend`
Expected: PASS, coverage thresholds met.

- [ ] **Step 5: Smoke-test the real backend manually (optional but recommended)**

Run: `npm run dev -w backend` — server starts, logs the startup scrape, and `curl http://localhost:3001/api/scrape/status` shows `running` with progressing pages. Stop with Ctrl-C (partial data is fine; it resumes). This is a manual check, not a test.

- [ ] **Step 6: Commit**

```bash
git add backend/src/api backend/src/index.ts backend/test/app.test.ts
git commit -m "feat(backend): Express API and startup bootstrap with resumable backfill"
```

---

### Task 11: Frontend scaffold + typed API client

**Files:**
- Create (via Vite scaffold + edits): `frontend/package.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/index.css`, `frontend/src/App.tsx`
- Create: `frontend/src/api/types.ts`, `frontend/src/api/client.ts`
- Create: `frontend/src/test/setup.ts`, `frontend/src/test/mocks.ts`
- Test: `frontend/src/test/client.test.ts`

**Interfaces:**
- Consumes: backend API routes (Task 10 shapes).
- Produces:
  - `frontend/src/api/types.ts`: `Tender`, `TenderPage`, `Facets`, `ScrapeStatus`, `TenderDetail = { tender: Tender; alsoAvailableFrom: Tender[] }` — structurally identical to the backend's (duplicated here deliberately: the frontend build must not depend on backend workspace internals; `@tms/shared`'s `Tender` type is imported for the record shape).
  - `frontend/src/api/client.ts`: `fetchTenders(params: Record<string, string>): Promise<TenderPage>`, `fetchFacets(): Promise<Facets>`, `fetchTender(id: string): Promise<TenderDetail>`, `fetchScrapeStatus(): Promise<ScrapeStatus>`, `triggerScrape(): Promise<void>` (throws `Error('scrape already running')` on 409).

- [ ] **Step 1: Scaffold the workspace**

```bash
npm create vite@latest frontend -- --template react-ts
npm install -w frontend
npm install -w frontend @tanstack/react-query react-router-dom @tms/shared
npm install -w frontend -D tailwindcss @tailwindcss/vite vitest @vitest/coverage-v8 jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom msw
```
Then set `frontend/package.json` `"test": "vitest run"` and ensure `"name": "@tms/frontend"`, `"private": true`.

Because `@tms/shared` is consumed as TypeScript source (its `main` points at `src/index.ts`), the frontend's `tsc -b` build step needs a paths mapping to typecheck it. In `frontend/tsconfig.app.json`, add to `compilerOptions`:
```json
"baseUrl": ".",
"paths": { "@tms/shared": ["../shared/src/index.ts"] }
```
(vitest/tsx resolve it via the workspace symlink without this; the mapping is for `tsc` only. Add the same mapping to `backend/tsconfig.json` for editor typechecking.)

`frontend/vite.config.ts`:
```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': 'http://localhost:3001' } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/main.tsx', 'src/test/**'],
      thresholds: { lines: 80, branches: 80 },
    },
  },
});
```

`frontend/src/index.css`:
```css
@import "tailwindcss";
```

- [ ] **Step 2: Write the failing test**

`frontend/src/test/setup.ts`:
```ts
import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import { server } from './mocks';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); cleanup(); });
afterAll(() => server.close());
```

`frontend/src/test/mocks.ts`:
```ts
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { Facets, ScrapeStatus, Tender, TenderPage } from '../api/types';

export function makeTender(overrides: Partial<Tender> = {}): Tender {
  return {
    id: 'myprocurement:1', source: 'myprocurement', sourceId: '1',
    referenceNo: 'UTHM/54/P/02/023/2026', dedupKey: 'UTHM/54/P/02/023/2026',
    title: 'MENYELENGGARA PERALATAN MAKMAL', sourceUrl: 'https://example.com/1',
    status: 'open', procurementType: 'quotation',
    ministry: 'KEMENTERIAN PENDIDIKAN TINGGI', agency: 'UTHM',
    category: 'Perkhidmatan Bukan Perunding', fieldCodes: ['060501'],
    advertisedDate: '2026-07-07', closingDate: '2026-07-17', indicativePrice: 28800,
    currency: 'MYR',
    events: [{ label: 'Lawatan Tapak', date: '2026-07-10', address: 'MAKMAL OR, KAJANG' }],
    raw: {}, scrapedAt: '2026-07-07T12:00:00.000Z',
    ...overrides,
  };
}

export const defaultPage: TenderPage = { items: [makeTender()], total: 1, page: 1, pageSize: 20 };
export const defaultFacets: Facets = {
  ministries: ['KEMENTERIAN PENDIDIKAN TINGGI'], agencies: ['UTHM'],
  categories: ['Perkhidmatan Bukan Perunding'], sources: ['myprocurement'],
  procurementTypes: ['quotation'],
};
export const idleStatus: ScrapeStatus = { state: 'idle' };

export const handlers = [
  http.get('/api/tenders/facets', () => HttpResponse.json(defaultFacets)),
  http.get('/api/tenders/:id', ({ params }) =>
    params.id === 'myprocurement:1'
      ? HttpResponse.json({ tender: makeTender(), alsoAvailableFrom: [] })
      : HttpResponse.json({ error: 'tender not found' }, { status: 404 })),
  http.get('/api/tenders', () => HttpResponse.json(defaultPage)),
  http.get('/api/scrape/status', () => HttpResponse.json(idleStatus)),
  http.post('/api/scrape', () => HttpResponse.json({ started: true }, { status: 202 })),
];

export const server = setupServer(...handlers);
```

`frontend/src/test/client.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { fetchFacets, fetchScrapeStatus, fetchTender, fetchTenders, triggerScrape } from '../api/client';
import { defaultFacets, defaultPage, server } from './mocks';

describe('api client', () => {
  it('fetchTenders passes query params and returns the page', async () => {
    let seenUrl = '';
    server.use(http.get('/api/tenders', ({ request }) => {
      seenUrl = request.url;
      return HttpResponse.json(defaultPage);
    }));
    const page = await fetchTenders({ search: 'makmal', status: 'open' });
    expect(page.total).toBe(1);
    expect(seenUrl).toContain('search=makmal');
    expect(seenUrl).toContain('status=open');
  });

  it('fetchFacets / fetchScrapeStatus / fetchTender return typed bodies', async () => {
    expect(await fetchFacets()).toEqual(defaultFacets);
    expect((await fetchScrapeStatus()).state).toBe('idle');
    expect((await fetchTender('myprocurement:1')).tender.id).toBe('myprocurement:1');
  });

  it('fetchTender throws on 404', async () => {
    await expect(fetchTender('nope:1')).rejects.toThrow();
  });

  it('triggerScrape resolves on 202 and throws on 409', async () => {
    await expect(triggerScrape()).resolves.toBeUndefined();
    server.use(http.post('/api/scrape', () => HttpResponse.json({ error: 'running' }, { status: 409 })));
    await expect(triggerScrape()).rejects.toThrow('scrape already running');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w frontend`
Expected: FAIL — `../api/client` / `../api/types` not found.

- [ ] **Step 4: Write the implementation**

`frontend/src/api/types.ts`:
```ts
import type { Tender } from '@tms/shared';
export type { Tender };

export interface TenderPage { items: Tender[]; total: number; page: number; pageSize: number }
export interface Facets {
  ministries: string[]; agencies: string[]; categories: string[];
  sources: string[]; procurementTypes: string[];
}
export interface ScrapeStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  source?: string; job?: string;
  jobsCompleted?: number; jobsTotal?: number;
  currentPage?: number; lastPage?: number;
  error?: string;
}
export interface TenderDetail { tender: Tender; alsoAvailableFrom: Tender[] }
```

`frontend/src/api/client.ts`:
```ts
import type { Facets, ScrapeStatus, TenderDetail, TenderPage } from './types';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`request failed: ${res.status} ${url}`);
  return res.json() as Promise<T>;
}

export function fetchTenders(params: Record<string, string>): Promise<TenderPage> {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '')).toString();
  return getJson(`/api/tenders${qs ? `?${qs}` : ''}`);
}

export function fetchFacets(): Promise<Facets> {
  return getJson('/api/tenders/facets');
}

export function fetchTender(id: string): Promise<TenderDetail> {
  return getJson(`/api/tenders/${encodeURIComponent(id)}`);
}

export function fetchScrapeStatus(): Promise<ScrapeStatus> {
  return getJson('/api/scrape/status');
}

export async function triggerScrape(): Promise<void> {
  const res = await fetch('/api/scrape', { method: 'POST' });
  if (res.status === 409) throw new Error('scrape already running');
  if (!res.ok) throw new Error(`scrape trigger failed: ${res.status}`);
}
```

Replace the Vite-scaffolded `frontend/src/App.tsx` with a placeholder (routing added in Tasks 12–14):
```tsx
export default function App() {
  return <div className="p-8 text-lg">Malaysia Tender Aggregator</div>;
}
```
And `frontend/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```
Delete Vite scaffold leftovers: `frontend/src/App.css`, `frontend/src/assets/`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w frontend`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend package-lock.json
git commit -m "feat(frontend): Vite scaffold, Tailwind, MSW test setup, typed API client"
```

---

### Task 12: Main page (list, search, filters, sorting, pagination)

**Files:**
- Create: `frontend/src/pages/MainPage.tsx`
- Modify: `frontend/src/App.tsx` (router + layout)
- Test: `frontend/src/test/MainPage.test.tsx`

**Interfaces:**
- Consumes: `fetchTenders`, `fetchFacets` (Task 11); react-router (`useNavigate`, `useSearchParams`), React Query.
- Produces: `MainPage` component rendered at `/`; `App` exports router with routes `/` → MainPage, `/tenders/:id` → DetailPage (DetailPage stubbed until Task 13); helper `renderWithProviders` in the test file used by later tests too.

- [ ] **Step 1: Write the failing test**

`frontend/src/test/MainPage.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import MainPage from '../pages/MainPage';
import { defaultPage, makeTender, server } from './mocks';

export function renderWithProviders(ui: React.ReactElement, { route = '/' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="/tenders/:id" element={<div>DETAIL PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MainPage', () => {
  it('renders tender rows from the API', async () => {
    renderWithProviders(<MainPage />);
    expect(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).toBeInTheDocument();
    expect(screen.getByText('UTHM/54/P/02/023/2026')).toBeInTheDocument();
  });

  it('populates filter dropdowns from facets and refetches on change', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderWithProviders(<MainPage />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    await userEvent.selectOptions(
      await screen.findByLabelText(/ministry/i),
      'KEMENTERIAN PENDIDIKAN TINGGI',
    );
    await waitFor(() =>
      expect(requests.some((u) => u.includes('ministry=KEMENTERIAN'))).toBe(true));
  });

  it('sends search text as a query param (debounced)', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderWithProviders(<MainPage />);
    await userEvent.type(screen.getByPlaceholderText(/search/i), 'makmal');
    await waitFor(() => expect(requests.some((u) => u.includes('search=makmal'))).toBe(true), { timeout: 2000 });
  });

  it('toggles sort on column header click', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderWithProviders(<MainPage />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    await userEvent.click(screen.getByRole('button', { name: /closing date/i }));
    await waitFor(() => expect(requests.some((u) => u.includes('sortBy=closingDate'))).toBe(true));
  });

  it('paginates', async () => {
    server.use(http.get('/api/tenders', ({ request }) => {
      const page = new URL(request.url).searchParams.get('page') ?? '1';
      return HttpResponse.json({
        items: [makeTender({ id: `myprocurement:p${page}`, title: `PAGE ${page} ITEM` })],
        total: 45, page: Number(page), pageSize: 20,
      });
    }));
    renderWithProviders(<MainPage />);
    await screen.findByText('PAGE 1 ITEM');
    expect(screen.getByText(/45/)).toBeInTheDocument(); // total shown
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('PAGE 2 ITEM')).toBeInTheDocument();
  });

  it('navigates to the detail page on row click', async () => {
    renderWithProviders(<MainPage />);
    await userEvent.click(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL'));
    expect(await screen.findByText('DETAIL PAGE')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend`
Expected: FAIL — `../pages/MainPage` not found.

- [ ] **Step 3: Write the implementation**

`frontend/src/pages/MainPage.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchFacets, fetchTenders } from '../api/client';

type SortBy = 'advertisedDate' | 'closingDate' | 'indicativePrice';

const FILTERS = [
  { key: 'ministry', label: 'Ministry', facet: 'ministries' },
  { key: 'agency', label: 'Agency', facet: 'agencies' },
  { key: 'category', label: 'Category', facet: 'categories' },
  { key: 'source', label: 'Source', facet: 'sources' },
  { key: 'procurementType', label: 'Type', facet: 'procurementTypes' },
] as const;

function formatPrice(v: number | null): string {
  return v === null ? '—' : `RM ${v.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;
}

export default function MainPage() {
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('advertisedDate');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const h = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
    return () => clearTimeout(h);
  }, [searchInput]);

  const params: Record<string, string> = {
    search, status, sortBy, sortOrder, page: String(page), ...filters,
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <input
          type="search"
          placeholder="Search title or reference no…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="border rounded-md px-3 py-2 w-72"
        />
        {FILTERS.map((f) => (
          <label key={f.key} className="flex flex-col text-sm gap-1">
            {f.label}
            <select
              className="border rounded-md px-2 py-2"
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
        <label className="flex flex-col text-sm gap-1">
          Status
          <select
            className="border rounded-md px-2 py-2"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          >
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </label>
      </div>

      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Reference No</th>
              <th className="px-3 py-2">Ministry</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">
                <button onClick={() => toggleSort('closingDate')}>Closing Date{sortIndicator('closingDate')}</button>
              </th>
              <th className="px-3 py-2">
                <button onClick={() => toggleSort('indicativePrice')}>Price{sortIndicator('indicativePrice')}</button>
              </th>
              <th className="px-3 py-2">Source</th>
            </tr>
          </thead>
          <tbody>
            {(pageData?.items ?? []).map((t) => (
              <tr
                key={t.id}
                onClick={() => navigate(`/tenders/${encodeURIComponent(t.id)}`)}
                className="border-t cursor-pointer hover:bg-blue-50"
              >
                <td className="px-3 py-2 font-medium max-w-xl">{t.title}</td>
                <td className="px-3 py-2 whitespace-nowrap">{t.referenceNo}</td>
                <td className="px-3 py-2">{t.ministry ?? '—'}</td>
                <td className="px-3 py-2 capitalize">{t.status}</td>
                <td className="px-3 py-2 capitalize">{t.procurementType}</td>
                <td className="px-3 py-2 whitespace-nowrap">{t.closingDate ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{formatPrice(t.indicativePrice)}</td>
                <td className="px-3 py-2">{t.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-4">
        <span>{pageData?.total ?? 0} tenders</span>
        <button
          className="border rounded-md px-3 py-1 disabled:opacity-50"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous
        </button>
        <span>Page {page} of {totalPages}</span>
        <button
          className="border rounded-md px-3 py-1 disabled:opacity-50"
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

`frontend/src/App.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import MainPage from './pages/MainPage';

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <header className="bg-blue-900 text-white px-6 py-4 flex items-center justify-between">
          <Link to="/" className="text-lg font-semibold">Malaysia Tender Aggregator</Link>
        </header>
        <main className="p-6">
          <Routes>
            <Route path="/" element={<MainPage />} />
          </Routes>
        </main>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
```
(Note: tests mount `MainPage` inside their own `MemoryRouter`; `App`'s `BrowserRouter` is for the real app. DetailPage route is added in Task 13, ScrapeBanner in Task 14.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): main page with search, filters, sorting, pagination"
```

---

### Task 13: Detail page

**Files:**
- Create: `frontend/src/pages/DetailPage.tsx`
- Modify: `frontend/src/App.tsx` (add route)
- Test: `frontend/src/test/DetailPage.test.tsx`

**Interfaces:**
- Consumes: `fetchTender` (Task 11); route param `:id`.
- Produces: `DetailPage` component at `/tenders/:id`.

- [ ] **Step 1: Write the failing test**

`frontend/src/test/DetailPage.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import DetailPage from '../pages/DetailPage';
import { makeTender, server } from './mocks';

function renderDetail(id: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/tenders/${encodeURIComponent(id)}`]}>
        <Routes>
          <Route path="/tenders/:id" element={<DetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DetailPage', () => {
  it('renders all tender fields including events and official link', async () => {
    renderDetail('myprocurement:1');
    expect(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).toBeInTheDocument();
    expect(screen.getByText('UTHM/54/P/02/023/2026')).toBeInTheDocument();
    expect(screen.getByText('KEMENTERIAN PENDIDIKAN TINGGI')).toBeInTheDocument();
    expect(screen.getByText('UTHM')).toBeInTheDocument();
    expect(screen.getByText('Perkhidmatan Bukan Perunding')).toBeInTheDocument();
    expect(screen.getByText('060501')).toBeInTheDocument();
    expect(screen.getByText('2026-07-17')).toBeInTheDocument();
    expect(screen.getByText(/RM\s*28,800/)).toBeInTheDocument();
    expect(screen.getByText('Lawatan Tapak')).toBeInTheDocument();
    expect(screen.getByText('MAKMAL OR, KAJANG')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /view on official site/i });
    expect(link).toHaveAttribute('href', 'https://example.com/1');
  });

  it('shows other sources when alsoAvailableFrom is non-empty', async () => {
    server.use(http.get('/api/tenders/:id', () => HttpResponse.json({
      tender: makeTender(),
      alsoAvailableFrom: [makeTender({ id: 'other:9', source: 'other', sourceUrl: 'https://other.example/9' })],
    })));
    renderDetail('myprocurement:1');
    expect(await screen.findByText(/also listed on/i)).toBeInTheDocument();
    expect(screen.getByText('other')).toBeInTheDocument();
  });

  it('shows an error state for unknown ids', async () => {
    renderDetail('nope:1');
    expect(await screen.findByText(/not found|failed/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend`
Expected: FAIL — `../pages/DetailPage` not found.

- [ ] **Step 3: Write the implementation**

`frontend/src/pages/DetailPage.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { fetchTender } from '../api/client';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row py-2 border-b last:border-b-0">
      <div className="sm:w-1/3 font-semibold">{label}</div>
      <div className="sm:w-2/3">{value ?? '—'}</div>
    </div>
  );
}

export default function DetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isError } = useQuery({
    queryKey: ['tender', id],
    queryFn: () => fetchTender(id!),
    enabled: Boolean(id),
  });

  if (isError) return <div className="text-red-700">Tender not found.</div>;
  if (!data) return <div>Loading…</div>;
  const t = data.tender;

  return (
    <div className="max-w-4xl space-y-6">
      <Link to="/" className="text-blue-700 underline">← Back to all tenders</Link>
      <h1 className="text-xl font-bold">{t.title}</h1>
      <a
        href={t.sourceUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-block bg-blue-900 text-white rounded-md px-4 py-2"
      >
        View on official site ↗
      </a>

      <div className="border rounded-lg p-4">
        <Field label="Reference No" value={t.referenceNo} />
        <Field label="Status" value={<span className="capitalize">{t.status}</span>} />
        <Field label="Procurement Type" value={<span className="capitalize">{t.procurementType}</span>} />
        <Field label="Ministry" value={t.ministry} />
        <Field label="Agency" value={t.agency} />
        <Field label="Category" value={t.category} />
        <Field label="Field Codes" value={t.fieldCodes.length ? t.fieldCodes.join(', ') : null} />
        <Field label="Advertised" value={t.advertisedDate} />
        <Field label="Closing" value={t.closingDate} />
        <Field
          label="Indicative Price"
          value={t.indicativePrice === null ? null
            : `RM ${t.indicativePrice.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`}
        />
        <Field label="Source" value={t.source} />
        <Field label="Scraped At" value={t.scrapedAt} />
      </div>

      {t.events.length > 0 && (
        <div>
          <h2 className="font-semibold mb-2">Events</h2>
          <table className="w-full text-sm border rounded-lg">
            <thead className="bg-gray-100 text-left">
              <tr><th className="px-3 py-2">Event</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Address</th></tr>
            </thead>
            <tbody>
              {t.events.map((e, i) => (
                <tr key={i} className="border-t">
                  <td className="px-3 py-2">{e.label}</td>
                  <td className="px-3 py-2">{e.date ?? '—'}</td>
                  <td className="px-3 py-2">{e.address ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.alsoAvailableFrom.length > 0 && (
        <div>
          <h2 className="font-semibold mb-2">Also listed on</h2>
          <ul className="list-disc pl-6">
            {data.alsoAvailableFrom.map((o) => (
              <li key={o.id}>
                <a href={o.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-700 underline">{o.source}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

In `frontend/src/App.tsx`, add the route:
```tsx
import DetailPage from './pages/DetailPage';
// inside <Routes>:
<Route path="/tenders/:id" element={<DetailPage />} />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): tender detail page with events and cross-source listing"
```

---

### Task 14: Scrape banner + rescrape button

**Files:**
- Create: `frontend/src/components/ScrapeBanner.tsx`
- Modify: `frontend/src/App.tsx` (mount in header)
- Test: `frontend/src/test/ScrapeBanner.test.tsx`

**Interfaces:**
- Consumes: `fetchScrapeStatus`, `triggerScrape` (Task 11); React Query (`useQuery` with `refetchInterval`, `useQueryClient` to invalidate `['tenders']` and `['facets']` when a run finishes).
- Produces: `ScrapeBanner` component (self-contained; no props).

- [ ] **Step 1: Write the failing test**

`frontend/src/test/ScrapeBanner.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import ScrapeBanner from '../components/ScrapeBanner';
import { server } from './mocks';

function renderBanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ScrapeBanner />
    </QueryClientProvider>,
  );
}

describe('ScrapeBanner', () => {
  it('shows an enabled Rescrape button when idle', async () => {
    renderBanner();
    const btn = await screen.findByRole('button', { name: /rescrape/i });
    expect(btn).toBeEnabled();
  });

  it('shows progress and disables the button while running', async () => {
    server.use(http.get('/api/scrape/status', () => HttpResponse.json({
      state: 'running', source: 'myprocurement', job: 'open-tender',
      jobsCompleted: 1, jobsTotal: 3, currentPage: 12, lastPage: 96,
    })));
    renderBanner();
    expect(await screen.findByText(/open-tender/)).toBeInTheDocument();
    expect(screen.getByText(/12\s*\/\s*96/)).toBeInTheDocument();
    expect(screen.getByText(/job 2\s*\/\s*3/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rescrape/i })).toBeDisabled();
  });

  it('shows the error message when failed', async () => {
    server.use(http.get('/api/scrape/status', () => HttpResponse.json({
      state: 'failed', error: 'fetch failed after 3 attempts: url',
    })));
    renderBanner();
    expect(await screen.findByText(/fetch failed after 3 attempts/)).toBeInTheDocument();
  });

  it('triggers a scrape on click', async () => {
    let posted = false;
    server.use(http.post('/api/scrape', () => { posted = true; return HttpResponse.json({ started: true }, { status: 202 }); }));
    renderBanner();
    await userEvent.click(await screen.findByRole('button', { name: /rescrape/i }));
    await waitFor(() => expect(posted).toBe(true));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w frontend`
Expected: FAIL — component not found.

- [ ] **Step 3: Write the implementation**

`frontend/src/components/ScrapeBanner.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { fetchScrapeStatus, triggerScrape } from '../api/client';

export default function ScrapeBanner() {
  const queryClient = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ['scrape-status'],
    queryFn: fetchScrapeStatus,
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 2000 : 10000),
  });
  const scrape = useMutation({
    mutationFn: triggerScrape,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['scrape-status'] }),
  });

  // When a run transitions out of 'running', refresh the tender list and facets.
  const prevState = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevState.current === 'running' && status?.state !== 'running') {
      queryClient.invalidateQueries({ queryKey: ['tenders'] });
      queryClient.invalidateQueries({ queryKey: ['facets'] });
    }
    prevState.current = status?.state;
  }, [status?.state, queryClient]);

  const running = status?.state === 'running';

  return (
    <div className="flex items-center gap-4">
      {running && (
        <span className="text-sm bg-blue-800 rounded-md px-3 py-1">
          Scraping {status?.source} — {status?.job}, page {status?.currentPage} / {status?.lastPage}
          {' '}(job {(status?.jobsCompleted ?? 0) + 1} / {status?.jobsTotal})
        </span>
      )}
      {status?.state === 'failed' && (
        <span className="text-sm bg-red-700 rounded-md px-3 py-1">Scrape failed: {status.error}</span>
      )}
      <button
        onClick={() => scrape.mutate()}
        disabled={running || scrape.isPending}
        className="bg-white text-blue-900 font-semibold rounded-md px-4 py-1.5 disabled:opacity-50"
      >
        Rescrape
      </button>
    </div>
  );
}
```

In `frontend/src/App.tsx`, mount it in the header:
```tsx
import ScrapeBanner from './components/ScrapeBanner';
// header becomes:
<header className="bg-blue-900 text-white px-6 py-4 flex items-center justify-between">
  <Link to="/" className="text-lg font-semibold">Malaysia Tender Aggregator</Link>
  <ScrapeBanner />
</header>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w frontend` then `npm test` (full suite, all workspaces)
Expected: PASS everywhere, coverage thresholds met.

- [ ] **Step 5: End-to-end manual smoke test**

Run backend (`npm run dev -w backend`) and frontend (`npm run dev -w frontend`), open http://localhost:5173: list populates as the startup scrape progresses (banner visible), filters/search/sort work, row click opens detail, Rescrape button disabled while running. This verifies the integration; automated coverage stays at the layer boundaries.

- [ ] **Step 6: Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): scrape progress banner and rescrape button"
```

---

### Task 15: Docker Compose

**Files:**
- Create: `backend/Dockerfile`, `frontend/Dockerfile`, `frontend/nginx.conf`, `docker-compose.yml`

**Interfaces:**
- Consumes: everything built so far.
- Produces: `docker compose up --build` serves the app on http://localhost:8080 with `/api` proxied to the backend; scraped data persisted in `./backend/data` on the host.

- [ ] **Step 1: Backend Dockerfile**

`backend/Dockerfile` (build context is the repo root — see compose file):
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
RUN npm ci --omit=dev --workspace shared --workspace backend
COPY shared shared
COPY backend backend
ENV DATA_DIR=/app/data
EXPOSE 3001
CMD ["npm", "run", "start", "-w", "backend"]
```

- [ ] **Step 2: Frontend Dockerfile + nginx config**

`frontend/nginx.conf`:
```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    location /api/ {
        proxy_pass http://backend:3001;
        proxy_set_header Host $host;
    }

    location / {
        try_files $uri /index.html;
    }
}
```

`frontend/Dockerfile` (build context is the repo root):
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY frontend/package.json frontend/
RUN npm ci --workspace shared --workspace frontend
COPY shared shared
COPY frontend frontend
RUN npm run build -w frontend

FROM nginx:alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

- [ ] **Step 3: docker-compose.yml**

```yaml
services:
  backend:
    build:
      context: .
      dockerfile: backend/Dockerfile
    ports:
      - "3001:3001"
    volumes:
      - ./backend/data:/app/data
    environment:
      - PORT=3001
      - DATA_DIR=/app/data

  frontend:
    build:
      context: .
      dockerfile: frontend/Dockerfile
    ports:
      - "8080:80"
    depends_on:
      - backend
```

- [ ] **Step 4: Verify**

Run: `docker compose up --build -d`, then:
- `curl http://localhost:3001/api/health` → `{"ok":true}`
- `curl http://localhost:8080/api/health` → `{"ok":true}` (nginx proxy works)
- Open http://localhost:8080 — app loads, scrape banner shows the startup scrape running.
- `docker compose down` then `docker compose up -d` — data persisted (no full re-scrape; archive backfill resumes only if it hadn't finished).

- [ ] **Step 5: Commit**

```bash
git add backend/Dockerfile frontend/Dockerfile frontend/nginx.conf docker-compose.yml
git commit -m "feat: docker compose with nginx frontend and persistent data volume"
```

---

### Task 16: Finalize README.md

**Files:**
- Modify: `README.md`

**Interfaces:** none — documentation only. CLAUDE.md was fully written in Task 1; re-read it now and correct anything that drifted during implementation.

- [ ] **Step 1: Write the full README**

`README.md`:
```markdown
# Malaysia Tender Aggregator

Consolidates publicly available Malaysian government tenders into one searchable
web app. Currently scrapes [MyProcurement](https://myprocurement.treasury.gov.my)
(open + archived tenders across quotation/tender/requisition categories); the
architecture supports adding more sources as pluggable adapters emitting one
standardized schema.

## Quick start (Docker)

    docker compose up --build

- App: http://localhost:8080
- API: http://localhost:3001/api

On first start the backend scrapes all sources in the background (open tenders
first-class, plus a one-time archive backfill of ~128k closed tenders — this takes
a while; the app is usable immediately and fills in as pages arrive). Data persists
in `backend/data/` between restarts; the backfill resumes if interrupted.

## Development

    npm install
    npm run dev -w backend    # Express API on :3001
    npm run dev -w frontend   # Vite dev server on :5173 (proxies /api)

## Testing

    npm test                  # all workspaces; also runs on every commit (husky)

TDD is enforced: pre-commit runs the full suite, and vitest enforces 80%
line/branch coverage per workspace. See CLAUDE.md for the workflow rules.

## API

| Route | Description |
|---|---|
| `GET /api/tenders` | List tenders. Query params: `search`, `ministry`, `agency`, `category`, `source`, `status` (open/closed), `procurementType` (quotation/tender/requisition), `sortBy` (advertisedDate/closingDate/indicativePrice), `sortOrder`, `page`, `pageSize` (max 100) |
| `GET /api/tenders/facets` | Distinct filter values |
| `GET /api/tenders/:id` | One tender + same-tender records from other sources |
| `POST /api/scrape` | Rescrape open tenders from all sources (409 if already running) |
| `GET /api/scrape/status` | Scrape progress: state, job, page x of y |
| `GET /api/health` | Liveness |

## Architecture

- `shared/` — Zod `Tender` schema: the standardized model every scraper must emit.
- `backend/` — Express API; scraper adapters (`src/scrapers/`); JSON-file storage in
  `data/<source>/` with atomic writes; scrape orchestration with per-page progress.
- `frontend/` — React + Vite + Tailwind; list page (search/filter/sort/paginate),
  detail page, scrape progress banner.

Cross-source duplicates are collapsed at query time by normalized tender number
(`dedupKey`); every source's record is preserved and surfaced on the detail page.

Scraping is polite: serial requests, 300ms+jitter delay (`SCRAPE_DELAY_MS` to tune),
exponential backoff, `Retry-After` honored on 429/503, identifying User-Agent.

## Adding a data source

See CLAUDE.md ("Adding a new data source").
```

- [ ] **Step 2: Verify docs against reality**

Re-read CLAUDE.md and README.md; run every command they mention (`npm test`, dev servers, `docker compose up`) and confirm each works as documented. Fix discrepancies.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: complete README with API reference and architecture"
```
