# SPAN Tender Data Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SPAN (span.gov.my) as a second tender data source, scraping its per-year HTML
listing pages (no JSON API available) into the same shared `Tender` schema already used by
MyProcurement, merging cross-source without ever overwriting a known field with "unknown."

**Architecture:** A new `ScraperAdapter` (`SpanAdapter` + `parseSpanListingHtml`) fetches
`GET /tender/<year>` for each year from 2017 to the current year, treating the current year
as a rescrapeable "open" job and all earlier years as one-time "archive" jobs — the same
open/archive split already used for MyProcurement, adapted to SPAN's year-based pagination
instead of page-number pagination. `procurementType` becomes nullable across the shared
schema (SPAN infers it from title wording and sometimes can't), and the repository's
null-never-clobbers guard is extended to cover it, so a `null` from SPAN can never erase a
real type already known from MyProcurement for the same tender.

**Tech Stack:** TypeScript, Zod, cheerio (HTML parsing), Vitest, existing `politeFetch`
rate-limiter (extended for text responses), React (frontend display only).

## Global Constraints

- Write the failing test FIRST for every change; confirm it fails for the right reason
  before implementing.
- Commit immediately after each task goes green. Never commit red.
- Tests must NEVER hit the real span.gov.my or myprocurement.treasury.gov.my. Use fixtures
  (`backend/test/fixtures/`) and injected fake fetchers only.
- Coverage thresholds (80% lines/branches) are enforced by vitest; do not lower thresholds
  or skip hooks (no `--no-verify`).
- Node 22, TypeScript, ESM everywhere (`.js` extensions on relative imports, matching every
  existing file in this codebase).
- Follow existing code style exactly: single quotes, semicolons, `type`-only imports where
  the codebase already does so (e.g. `import type { AnyNode, Cheerio } from 'cheerio';`).

---

### Task 1: `procurementType` becomes nullable in the shared schema

**Files:**
- Modify: `shared/src/tender.ts:28` (`TenderSchema`), `shared/src/tender.ts:55` (`TenderPatchSchema`)
- Test: `shared/test/tender.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Tender['procurementType']` and `TenderPatch['procurementType']` become
  `'quotation' | 'tender' | 'requisition' | null` (previously non-nullable). Every later
  task that reads/writes `procurementType` relies on this.

- [ ] **Step 1: Write the failing tests**

Add these two `it` blocks — one inside the existing `describe('TenderSchema', ...)` block,
one inside `describe('TenderPatchSchema', ...)` — in `shared/test/tender.test.ts`:

```ts
  it('accepts procurementType: null (source could not classify the tender type)', () => {
    const t = makeTender({ procurementType: null });
    expect(TenderSchema.parse(t)).toEqual(t);
  });
```

```ts
  it('accepts procurementType: null (source could not classify the tender type)', () => {
    const patch = makePatch({ procurementType: null });
    expect(TenderPatchSchema.parse(patch)).toEqual(patch);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w shared`
Expected: FAIL — both new tests throw inside `.parse(...)` because `null` is not one of the
three enum values yet.

- [ ] **Step 3: Make the schema nullable**

In `shared/src/tender.ts`, change line 28 (inside `TenderSchema`) from:

```ts
  procurementType: z.enum(['quotation', 'tender', 'requisition']),
```

to:

```ts
  procurementType: z.enum(['quotation', 'tender', 'requisition']).nullable(),
```

And change line 55 (inside `TenderPatchSchema`, currently identical text) the same way:

```ts
  procurementType: z.enum(['quotation', 'tender', 'requisition']).nullable(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w shared`
Expected: PASS (all tests in the `shared` workspace, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add shared/src/tender.ts shared/test/tender.test.ts
git commit -m "feat(shared): allow procurementType to be null for unclassifiable sources"
```

---

### Task 2: Repository must never let a null `procurementType` (or an omitted field) overwrite a known value from another source

**Files:**
- Modify: `backend/src/storage/repository.ts:24-26` (`NULLABLE_FIELDS`)
- Test: `backend/test/repository.test.ts`

**Interfaces:**
- Consumes: `Tender`/`TenderPatch` types from Task 1 (`procurementType` now nullable).
- Produces: no new exports — this only changes merge *behavior*, verified by the new tests.

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the existing `describe('TenderRepository', ...)` block in
`backend/test/repository.test.ts` (place them near the existing `'never lets a null value
clobber...'` ministry test, around line 55-61):

```ts
  it('never lets a different source\'s unclassifiable (null) procurementType clobber an already-known type', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({ procurementType: 'tender', scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    repo.mergeMany([makePatch({
      procurementType: null,
      scrapedAt: '2026-07-07T00:00:00.000Z',
      source: { source: 'span', sourceId: '9', sourceUrl: 'https://www.span.gov.my/tender/view/9' },
    })]);
    expect(repo.getAll()[0]!.procurementType).toBe('tender');
  });

  it('never lets a different source without fieldCodes/winners erase values another source already contributed', async () => {
    const { repo } = freshRepo();
    await repo.load();
    repo.mergeMany([makePatch({
      fieldCodes: ['E05'],
      winners: [{ name: 'X', price: 1 }],
      scrapedAt: '2026-07-01T00:00:00.000Z',
    })]);
    // A real span.gov.my patch never observes fieldCodes/winners, so it omits those keys
    // entirely rather than sending [] — this proves that omission, not a source, protects them.
    repo.mergeMany([makePatch({
      scrapedAt: '2026-07-07T00:00:00.000Z',
      source: { source: 'span', sourceId: '9', sourceUrl: 'https://www.span.gov.my/tender/view/9' },
    })]);
    const [t] = repo.getAll();
    expect(t!.fieldCodes).toEqual(['E05']);
    expect(t!.winners).toEqual([{ name: 'X', price: 1 }]);
  });
```

- [ ] **Step 2: Run tests to verify the first one fails**

Run: `npm test -w backend -- test/repository.test.ts`
Expected: the first new test FAILS (`procurementType` becomes `null`, not `'tender'`) because
`procurementType` isn't in `NULLABLE_FIELDS` yet. The second test already PASSES today
(omission was already handled generically) — that's expected; it's here as a regression
guard for this exact cross-source scenario, not a new behavior.

- [ ] **Step 3: Add `procurementType` to `NULLABLE_FIELDS`**

In `backend/src/storage/repository.ts`, change lines 24-26 from:

```ts
const NULLABLE_FIELDS = new Set([
  'ministry', 'agency', 'category', 'advertisedDate', 'closingDate', 'indicativePrice', 'winners',
]);
```

to:

```ts
const NULLABLE_FIELDS = new Set([
  'ministry', 'agency', 'category', 'advertisedDate', 'closingDate', 'indicativePrice',
  'winners', 'procurementType',
]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend -- test/repository.test.ts`
Expected: PASS (both new tests, and all pre-existing repository tests still pass).

- [ ] **Step 5: Commit**

```bash
git add backend/src/storage/repository.ts backend/test/repository.test.ts
git commit -m "fix(backend): never let a null procurementType overwrite a known type across sources"
```

---

### Task 3: Date parser for SPAN's already-ISO date strings

**Files:**
- Modify: `backend/src/parsing/text.ts` (append new function)
- Test: `backend/test/text.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseIsoDatePrefix(s: string | null | undefined): string | null` — Task 5's
  parser calls this for SPAN's `Tarikh Iklan`/`Tarikh Tutup` fields (format `YYYY-MM-DD` or
  `YYYY-MM-DD H:MMAM/PM`), analogous to how `parseDdMmYyyy` serves MyProcurement's
  `dd/mm/yyyy` fields.

- [ ] **Step 1: Write the failing test**

Add this `describe` block to the end of `backend/test/text.test.ts`, and add
`parseIsoDatePrefix` to the existing import on line 2:

```ts
import { parseDdMmYyyy, parseIsoDatePrefix, parseRmPrice, splitFieldCodes } from '../src/parsing/text.js';
```

```ts
describe('parseIsoDatePrefix', () => {
  it('parses a bare ISO date', () => {
    expect(parseIsoDatePrefix('2026-06-22')).toBe('2026-06-22');
  });
  it('parses an ISO date with a trailing time, dropping the time', () => {
    expect(parseIsoDatePrefix('2026-07-06 12:00PM')).toBe('2026-07-06');
  });
  it('returns null for invalid or missing input', () => {
    expect(parseIsoDatePrefix('2026-13-01')).toBeNull(); // no month 13
    expect(parseIsoDatePrefix('2026-02-30')).toBeNull(); // no Feb 30
    expect(parseIsoDatePrefix('22/06/2026')).toBeNull(); // wrong format
    expect(parseIsoDatePrefix('')).toBeNull();
    expect(parseIsoDatePrefix(null)).toBeNull();
    expect(parseIsoDatePrefix(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w backend -- test/text.test.ts`
Expected: FAIL with "parseIsoDatePrefix is not a function" / import error.

- [ ] **Step 3: Implement the function**

Append to the end of `backend/src/parsing/text.ts`:

```ts

export function parseIsoDatePrefix(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (date.getUTCFullYear() !== yyyy || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w backend -- test/text.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/parsing/text.ts backend/test/text.test.ts
git commit -m "feat(backend): add parseIsoDatePrefix for already-ISO date strings"
```

---

### Task 4: `politeFetch` supports text (HTML) responses, not just JSON

**Files:**
- Modify: `backend/src/http/politeFetch.ts`
- Test: `backend/test/politeFetch.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `createPoliteFetcher(opts)` accepts an additional `responseType?: 'json' |
  'text'` option (default `'json'`, so every existing call site — MyProcurement's — is
  unaffected). Task 6's `SpanAdapter` will call `createPoliteFetcher({ responseType: 'text'
  })`.

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to the end of `backend/test/politeFetch.test.ts`:

```ts
describe('createPoliteFetcher — text mode', () => {
  it('returns raw text and sends Accept: text/html when responseType is "text"', async () => {
    const { sleep, fetchImpl } = setup([new Response('<html>hi</html>', { status: 200 })]);
    const f = createPoliteFetcher({ responseType: 'text', fetchImpl, sleep, random: () => 0 });
    await expect(f('http://x/a')).resolves.toBe('<html>hi</html>');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Accept).toBe('text/html');
  });

  it('still retries/backs off the same way in text mode', async () => {
    const { sleeps, sleep, fetchImpl } = setup([new Error('boom'), new Response('ok', { status: 200 })]);
    const f = createPoliteFetcher({
      responseType: 'text', baseDelayMs: 0, jitterMs: 0, fetchImpl, sleep, random: () => 0,
    });
    await expect(f('http://x/a')).resolves.toBe('ok');
    expect(sleeps.filter((ms) => ms > 0)).toEqual([1000]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- test/politeFetch.test.ts`
Expected: FAIL — `createPoliteFetcher` doesn't accept `responseType` yet, so it still sends
`Accept: application/json` and calls `res.json()` on a non-JSON body (`res.json()` on
`'<html>hi</html>'` throws a JSON parse error).

- [ ] **Step 3: Implement `responseType` support**

In `backend/src/http/politeFetch.ts`, change the `PoliteFetcherOptions` interface (currently
lines 1-10) to add the new field:

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
  responseType?: 'json' | 'text';
}
```

Then, inside `createPoliteFetcher`, add a `responseType`/`accept` binding alongside the
other option bindings (after the existing `const random = opts.random ?? Math.random;`
line):

```ts
  const responseType = opts.responseType ?? 'json';
  const accept = responseType === 'text' ? 'text/html' : 'application/json';
```

Finally, update the two lines that build the request and parse the response:

```ts
        const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept } });
        if (res.ok) return await (responseType === 'text' ? res.text() : res.json());
```

(These replace the current `Accept: 'application/json'` request line and the `if (res.ok)
return await res.json();` line.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend -- test/politeFetch.test.ts`
Expected: PASS (new text-mode tests, and every pre-existing JSON-mode test — confirming the
default behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add backend/src/http/politeFetch.ts backend/test/politeFetch.test.ts
git commit -m "feat(backend): support text/HTML responses in the polite fetcher"
```

---

### Task 5: SPAN listing-page parser

**Files:**
- Create: `backend/src/scrapers/span/parseListing.ts`
- Create: `backend/test/fixtures/span-2026.html`
- Create: `backend/test/spanParseListing.test.ts`

**Interfaces:**
- Consumes: `TenderPatchSchema`, `computeDedupKey`, `TenderPatch` from `@tms/shared` (Task
  1); `parseIsoDatePrefix` from `../../parsing/text.js` (Task 3).
- Produces: `parseSpanListingHtml(html: string, ctx?: { now?: () => string }):
  TenderPatch[]` — Task 6's `SpanAdapter` imports and calls this with the raw HTML string
  returned by the text-mode fetcher.

- [ ] **Step 1: Create the fixture file**

Create `backend/test/fixtures/span-2026.html` with this exact content (five real cards
captured from `https://www.span.gov.my/tender/2026` on 2026-07-09, covering every
status/type combination this parser must handle: open+quotation-keyword,
open+tender-keyword, completed+quotation-keyword, cancelled+quotation-keyword, and
open+tender-keyword-with-a-package-suffix):

```html
<div class="container__right">
    <div class="table-listing">
        <a href="https://www.span.gov.my/tender/view/188">
            <h3>SPAN/BKP/PROC/STM/26(8)</h3>
            CADANGAN UNTUK MELANTIK PERUNDING BAGI PELAKSANAAN KAJIAN HALA TUJU PELAN STRATEGIK ICT (GAP ANALYSIS) SURUHANJAYA PERKHIDMATAN AIR NEGARA (SPAN) 2026-2030 SECARA SEBUT HARGA TERBUKA<br>
            Tarikh Iklan 2026-06-22<br>
            Tarikh Tutup 2026-07-06 12:00PM<br>
            Maklumat Sebutharga:
                <span class="badge badge-warning">Diiklankan</span>
                    </a>
    </div>
    <div class="table-listing">
        <a href="https://www.span.gov.my/tender/view/183">
            <h3>SPAN/BKP/PROC/STM/26(6)</h3>
            CADANGAN UNTUK MELANTIK PEMBEKAL BAGI PERKHIDMATAN PEMBAHARUAN KHIDMAT SOKONGAN DAN PENYELENGGARAAN SISTEM ELECTRONIC CENTRALISED LICENCE AND PERMIT SYSTEM (ECLAPS) UNTUK TEMPOH TIGA (3) TAHUN DI SURUHANJAYA PERKHIDMATAN AIR NEGARA (SPAN) SECARA TENDER TERBUKA<br>
            Tarikh Iklan 2026-06-10<br>
            Tarikh Tutup 2026-07-01 12:00PM<br>
            Maklumat Sebutharga:
                <span class="badge badge-warning">Diiklankan</span>
                    </a>
    </div>
    <div class="table-listing">
        <a href="https://www.span.gov.my/tender/view/182">
            <h3>SPAN/BKP/PROC/STM/26(5)</h3>
            CADANGAN UNTUK MELANTIK PEMBEKAL BAGI MENYEDIAKAN PERKHIDMATAN PELAN PEMULIHAN BENCANA (DISASTER RECOVERY PLAN) DI SURUHANJAYA PERKHIDMATAN AIR NEGARA (SPAN) BAGI TEMPOH 3 TAHUN SECARA SEBUT HARGA TERBUKA<br>
            Tarikh Iklan 2026-05-07<br>
            Tarikh Tutup 2026-05-18 12:00PM<br>
            Maklumat Sebutharga:

                <span class="badge badge-info">Selesai</span>
                    </a>
    </div>
    <div class="table-listing">
        <a href="https://www.span.gov.my/tender/view/177">
            <h3>SPAN/BKP/PROC/STM/26(3)</h3>
            CADANGAN UNTUK MELANTIK PEMBEKAL BAGI MENYEDIAKAN PERKHIDMATAN PELAN PEMULIHAN BENCANA (DISASTER RECOVERY PLAN) DI SURUHANJAYA PERKHIDMATAN AIR NEGARA (SPAN) SECARA SEBUT HARGA TERBUKA<br>
            Tarikh Iklan 2026-04-02<br>
            Tarikh Tutup 2026-04-15 12:00PM<br>
            Maklumat Sebutharga:
                <span class="badge badge-warning">Dibatalkan</span>
                    </a>
    </div>
    <div class="table-listing">
        <a href="https://www.span.gov.my/tender/view/171">
            <h3>SPAN/BKP/PROC/KWSMP/26(1)</h3>
            CADANGAN MELANTIK PERUNDING SEBAGAI PEMERIKSA BAGI PROJEK MENAIK TARAF LOJI RAWATAN KUMBAHAN KE PERENGGAN (I), STANDARD A, PERATURAN-PERATURAN KUALITI ALAM SEKELILING (KUMBAHAN) 2009 – FASA 2 DI BAWAH PEMBIAYAAN DANA KUMPULAN WANG SUMBANGAN MODAL PEMBETUNGAN (KWSMP) SECARA TENDER TERBUKA – PAKEJ 1 (KEDAH, PULAU PINANG, PERAK, PAHANG, SELANGOR DAN NEGERI SEMBILAN)<br>
            Tarikh Iklan 2026-01-27<br>
            Tarikh Tutup 2026-02-23 12:00PM<br>
            Maklumat Sebutharga:
                <span class="badge badge-warning">Diiklankan</span>
                    </a>
    </div>
</div>
```

- [ ] **Step 2: Write the failing test file**

Create `backend/test/spanParseListing.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TenderPatchSchema } from '@tms/shared';
import { parseSpanListingHtml } from '../src/scrapers/span/parseListing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = () => '2026-07-09T12:00:00.000Z';

const CARD_HTML = `<div class="table-listing">
    <a href="https://www.span.gov.my/tender/view/188">
        <h3>SPAN/BKP/PROC/STM/26(8)</h3>
        CADANGAN UNTUK MELANTIK PERUNDING BAGI PELAKSANAAN KAJIAN HALA TUJU PELAN STRATEGIK ICT (GAP ANALYSIS) SURUHANJAYA PERKHIDMATAN AIR NEGARA (SPAN) 2026-2030 SECARA SEBUT HARGA TERBUKA<br>
        Tarikh Iklan 2026-06-22<br>
        Tarikh Tutup 2026-07-06 12:00PM<br>
        Maklumat Sebutharga:
            <span class="badge badge-warning">Diiklankan</span>
                </a>
</div>`;

describe('parseSpanListingHtml — embedded card, exact values', () => {
  it('extracts every field from a card, shaped as a TenderPatch', () => {
    const [t] = parseSpanListingHtml(CARD_HTML, { now: NOW });
    expect(t).toBeDefined();
    expect(t!.source).toEqual({
      source: 'span', sourceId: '188',
      sourceUrl: 'https://www.span.gov.my/tender/view/188',
    });
    expect(t!.referenceNo).toBe('SPAN/BKP/PROC/STM/26(8)');
    expect(t!.dedupKey).toBe('SPAN/BKP/PROC/STM/26(8)');
    expect(t!.title).toBe(
      'CADANGAN UNTUK MELANTIK PERUNDING BAGI PELAKSANAAN KAJIAN HALA TUJU PELAN STRATEGIK ICT (GAP ANALYSIS) SURUHANJAYA PERKHIDMATAN AIR NEGARA (SPAN) 2026-2030 SECARA SEBUT HARGA TERBUKA',
    );
    expect(t!.status).toBe('open');
    expect(t!.procurementType).toBe('quotation');
    expect(t!.agency).toBe('Suruhanjaya Perkhidmatan Air Negara (SPAN)');
    expect(t!.advertisedDate).toBe('2026-06-22');
    expect(t!.closingDate).toBe('2026-07-06');
    expect(t!.raw!['Status']).toBe('Diiklankan');
    expect(t!.scrapedAt).toBe('2026-07-09T12:00:00.000Z');
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('maps "Selesai" and "Dibatalkan" badges to status closed', () => {
    const selesai = CARD_HTML.replace('badge-warning">Diiklankan', 'badge-info">Selesai');
    expect(parseSpanListingHtml(selesai, { now: NOW })[0]!.status).toBe('closed');
    const dibatalkan = CARD_HTML.replace('Diiklankan', 'Dibatalkan');
    expect(parseSpanListingHtml(dibatalkan, { now: NOW })[0]!.status).toBe('closed');
  });

  it('infers procurementType "tender" from a TENDER keyword in the title', () => {
    const tenderCard = CARD_HTML.replace('SECARA SEBUT HARGA TERBUKA', 'SECARA TENDER TERBUKA');
    expect(parseSpanListingHtml(tenderCard, { now: NOW })[0]!.procurementType).toBe('tender');
  });

  it('defaults procurementType to null when no recognizable keyword is present', () => {
    const noKeyword = CARD_HTML.replace('SECARA SEBUT HARGA TERBUKA', 'UNTUK KEGUNAAN SURUHANJAYA');
    const [t] = parseSpanListingHtml(noKeyword, { now: NOW });
    expect(t!.procurementType).toBeNull();
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('omits ministry/category/fieldCodes/indicativePrice/events/winners entirely (not observed by this source)', () => {
    const [t] = parseSpanListingHtml(CARD_HTML, { now: NOW });
    expect(t).not.toHaveProperty('ministry');
    expect(t).not.toHaveProperty('category');
    expect(t).not.toHaveProperty('fieldCodes');
    expect(t).not.toHaveProperty('indicativePrice');
    expect(t).not.toHaveProperty('events');
    expect(t).not.toHaveProperty('winners');
  });

  it('skips a card with no parseable href instead of throwing', () => {
    const noHref = CARD_HTML.replace('href="https://www.span.gov.my/tender/view/188"', '');
    expect(parseSpanListingHtml(noHref, { now: NOW })).toEqual([]);
  });

  it('skips a card with an empty reference number instead of throwing', () => {
    const noRef = CARD_HTML.replace('<h3>SPAN/BKP/PROC/STM/26(8)</h3>', '<h3></h3>');
    expect(parseSpanListingHtml(noRef, { now: NOW })).toEqual([]);
  });

  it('falls back to Date.now() when ctx.now is not provided', () => {
    const [t] = parseSpanListingHtml(CARD_HTML);
    expect(typeof t!.scrapedAt).toBe('string');
    expect(t!.scrapedAt.length).toBeGreaterThan(0);
  });
});

describe('parseSpanListingHtml — live fixture, structural invariants', () => {
  it('parses every card in the fixture into schema-valid patches', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'span-2026.html'), 'utf8');
    const patches = parseSpanListingHtml(html, { now: NOW });
    expect(patches).toHaveLength(5);
    const idsInHtml = new Set([...html.matchAll(/\/tender\/view\/(\d+)/g)].map((m) => m[1]));
    expect(new Set(patches.map((t) => t.source.sourceId))).toEqual(idsInHtml);
    for (const t of patches) {
      expect(() => TenderPatchSchema.parse(t)).not.toThrow();
      expect(t.source.source).toBe('span');
      if (t.advertisedDate) expect(t.advertisedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (t.closingDate) expect(t.closingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // Exactly one of the five fixture cards is cancelled ("Dibatalkan") and one is
    // completed ("Selesai") — both must be tagged closed; the other three are Diiklankan/open.
    expect(patches.filter((t) => t.status === 'closed')).toHaveLength(2);
    expect(patches.filter((t) => t.status === 'open')).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w backend -- test/spanParseListing.test.ts`
Expected: FAIL — `../src/scrapers/span/parseListing.js` does not exist yet.

- [ ] **Step 4: Implement the parser**

Create `backend/src/scrapers/span/parseListing.ts`:

```ts
import * as cheerio from 'cheerio';
import type { AnyNode, Cheerio } from 'cheerio';
import { TenderPatchSchema, computeDedupKey, type TenderPatch } from '@tms/shared';
import { parseIsoDatePrefix } from '../../parsing/text.js';

export interface SpanJobContext {
  now?: () => string;
}

const SOURCE = 'span';
const AGENCY = 'Suruhanjaya Perkhidmatan Air Negara (SPAN)';

export function parseSpanListingHtml(html: string, ctx: SpanJobContext = {}): TenderPatch[] {
  const $ = cheerio.load(html);
  const now = ctx.now ?? (() => new Date().toISOString());
  const patches: TenderPatch[] = [];

  $('div.table-listing').each((_, el) => {
    const candidate = parseCard($, $(el), now());
    if (!candidate) return;
    const result = TenderPatchSchema.safeParse(candidate);
    if (!result.success) {
      console.warn(`[span] skipping invalid card: ${result.error.message}`);
      return;
    }
    patches.push(result.data);
  });

  return patches;
}

function parseCard(
  $: cheerio.CheerioAPI,
  card: Cheerio<AnyNode>,
  scrapedAt: string,
): Record<string, unknown> | null {
  const link = card.find('a').first();
  const sourceUrl = link.attr('href') ?? '';
  const idMatch = sourceUrl.match(/\/tender\/view\/(\d+)/);
  if (!idMatch || !sourceUrl) return null;
  const sourceId = idMatch[1]!;

  const referenceNo = clean(link.find('h3').first().text());
  if (!referenceNo) return null;

  const fullText = clean(link.text());
  const afterHeading = fullText.slice(fullText.indexOf(referenceNo) + referenceNo.length);
  const titleMatch = afterHeading.match(/^(.*?)\s*Tarikh Iklan/);
  const title = clean(titleMatch ? titleMatch[1]! : '');
  if (!title) return null;

  const advertisedMatch = fullText.match(/Tarikh Iklan\s*([\d-]+)/);
  const closingMatch = fullText.match(/Tarikh Tutup\s*([\d-]+(?:\s+\d{1,2}:\d{2}[AP]M)?)/);
  const badgeText = clean(card.find('.badge').first().text());

  const status: 'open' | 'closed' = badgeText === 'Diiklankan' ? 'open' : 'closed';
  const procurementType = inferProcurementType(title);

  const raw: Record<string, string> = { 'No Sebut Harga': referenceNo, Tajuk: title, Status: badgeText };
  if (advertisedMatch) raw['Tarikh Iklan'] = advertisedMatch[1]!;
  if (closingMatch) raw['Tarikh Tutup'] = closingMatch[1]!;

  const fallback = `${SOURCE}:${sourceId}`;
  return {
    dedupKey: computeDedupKey(referenceNo, fallback),
    referenceNo,
    title,
    status,
    procurementType,
    scrapedAt,
    source: { source: SOURCE, sourceId, sourceUrl },
    agency: AGENCY,
    advertisedDate: advertisedMatch ? parseIsoDatePrefix(advertisedMatch[1]) : null,
    closingDate: closingMatch ? parseIsoDatePrefix(closingMatch[1]) : null,
    raw,
  };
}

function inferProcurementType(title: string): 'quotation' | 'tender' | null {
  if (/TENDER/i.test(title)) return 'tender';
  if (/SEBUT\s*HARGA/i.test(title)) return 'quotation';
  return null;
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w backend -- test/spanParseListing.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/scrapers/span/parseListing.ts backend/test/spanParseListing.test.ts backend/test/fixtures/span-2026.html
git commit -m "feat(backend): add SPAN listing-page parser"
```

---

### Task 6: `SpanAdapter` — year-based job scraping

**Files:**
- Create: `backend/src/scrapers/span/adapter.ts`
- Create: `backend/test/spanAdapter.test.ts`

**Interfaces:**
- Consumes: `parseSpanListingHtml` (Task 5); `ScrapeHooks`, `ScrapeOptions`, `ScrapeScope`,
  `ScraperAdapter` from `../types.js` (already exist, unchanged).
- Produces: `class SpanAdapter implements ScraperAdapter`, constructed as `new
  SpanAdapter(fetcher: (url: string) => Promise<unknown>, now?: () => number)`. Task 7
  wires this into `backend/src/index.ts`.

- [ ] **Step 1: Write the failing test file**

Create `backend/test/spanAdapter.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { TenderPatch } from '@tms/shared';
import { SpanAdapter } from '../src/scrapers/span/adapter.js';

const FIXED_NOW = () => new Date('2026-07-09T00:00:00.000Z').getTime(); // current year: 2026
const MIN_YEAR = 2017;
const CURRENT_YEAR = 2026;

function pageHtml(id: number, ref: string, badge = 'Diiklankan'): string {
  return `<div class="table-listing">
    <a href="https://www.span.gov.my/tender/view/${id}">
      <h3>${ref}</h3>
      SOME TITLE SECARA TENDER TERBUKA<br>
      Tarikh Iklan 2026-01-01<br>
      Tarikh Tutup 2026-01-15 12:00PM<br>
      Maklumat Sebutharga: <span class="badge">${badge}</span>
    </a>
  </div>`;
}

describe('SpanAdapter — job model', () => {
  it('builds one closed job per year from 2017 up to (but not including) the current year', () => {
    const adapter = new SpanAdapter(vi.fn(), FIXED_NOW);
    expect(adapter.archiveJobNames()).toEqual(
      Array.from({ length: CURRENT_YEAR - MIN_YEAR }, (_, i) => `closed-${CURRENT_YEAR - 1 - i}`),
    );
  });

  it('scope=open fetches only the current year, at /tender/<year>', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { urls.push(url); return pageHtml(1, 'REF/1'); });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    const batches: TenderPatch[][] = [];
    await adapter.scrape('open', { onProgress: () => {}, onBatch: async (t) => { batches.push(t); } });
    expect(urls).toEqual(['https://www.span.gov.my/tender/2026']);
    expect(batches).toHaveLength(1);
    expect(batches[0]![0]!.status).toBe('open');
  });

  it('scope=archive fetches every year except the current one', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { urls.push(url); return pageHtml(1, 'REF/1'); });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    await adapter.scrape('archive', { onProgress: () => {}, onBatch: async () => {} });
    expect(urls).toEqual(
      Array.from({ length: CURRENT_YEAR - MIN_YEAR }, (_, i) => `https://www.span.gov.my/tender/${CURRENT_YEAR - 1 - i}`),
    );
  });

  it('scope=all fetches every year, current year first', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { urls.push(url); return pageHtml(1, 'REF/1'); });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    await adapter.scrape('all', { onProgress: () => {}, onBatch: async () => {} });
    expect(urls[0]).toBe('https://www.span.gov.my/tender/2026');
    expect(urls).toHaveLength(CURRENT_YEAR - MIN_YEAR + 1);
  });

  it('skips closed jobs already present in skipJobNames, but never skips the open job', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { urls.push(url); return pageHtml(1, 'REF/1'); });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    await adapter.scrape('all', { onProgress: () => {}, onBatch: async () => {} }, {
      skipJobNames: new Set(['closed-2025', 'closed-2024']),
    });
    expect(urls).not.toContain('https://www.span.gov.my/tender/2025');
    expect(urls).not.toContain('https://www.span.gov.my/tender/2024');
    expect(urls).toContain('https://www.span.gov.my/tender/2026');
    expect(urls).toContain('https://www.span.gov.my/tender/2023');
  });

  it('calls onJobDone with each job name once it finishes, and reports progress', async () => {
    const fetcher = vi.fn(async () => pageHtml(1, 'REF/1'));
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    const done: string[] = [];
    const progress: unknown[] = [];
    await adapter.scrape('open', {
      onProgress: (p) => progress.push({ ...p }),
      onBatch: async () => {},
      onJobDone: (name) => done.push(name),
    });
    expect(done).toEqual(['open-2026']);
    expect(progress[0]).toEqual({
      source: 'span', job: 'open-2026', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1,
    });
  });

  it('rejects when the fetcher fails, without calling onBatch', async () => {
    const fetcher = vi.fn(async () => { throw new Error('fetch failed after 3 attempts: x'); });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    const onBatch = vi.fn(async () => {});
    await expect(adapter.scrape('open', { onProgress: () => {}, onBatch })).rejects.toThrow('fetch failed');
    expect(onBatch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- test/spanAdapter.test.ts`
Expected: FAIL — `../src/scrapers/span/adapter.js` does not exist yet.

- [ ] **Step 3: Implement the adapter**

Create `backend/src/scrapers/span/adapter.ts`:

```ts
import { z } from 'zod';
import type { ScrapeHooks, ScrapeOptions, ScrapeScope, ScraperAdapter } from '../types.js';
import { parseSpanListingHtml } from './parseListing.js';

const BASE_URL = 'https://www.span.gov.my/tender';
const MIN_YEAR = 2017;

const HtmlResponse = z.string().min(1);

interface SpanJob {
  year: number;
  status: 'open' | 'closed';
}

function buildJobs(currentYear: number): SpanJob[] {
  const jobs: SpanJob[] = [];
  for (let year = currentYear; year >= MIN_YEAR; year -= 1) {
    jobs.push({ year, status: year === currentYear ? 'open' : 'closed' });
  }
  return jobs;
}

function jobName(job: SpanJob): string {
  return `${job.status}-${job.year}`;
}

export class SpanAdapter implements ScraperAdapter {
  readonly name = 'span';
  private readonly jobs: SpanJob[];

  constructor(
    private readonly fetcher: (url: string) => Promise<unknown>,
    now: () => number = () => Date.now(),
  ) {
    this.jobs = buildJobs(new Date(now()).getFullYear());
  }

  archiveJobNames(): string[] {
    return this.jobs.filter((j) => j.status === 'closed').map(jobName);
  }

  async scrape(scope: ScrapeScope, hooks: ScrapeHooks, opts: ScrapeOptions = {}): Promise<void> {
    const jobs = this.jobs.filter((j) => {
      const inScope = scope === 'all' ? true : scope === 'open' ? j.status === 'open' : j.status === 'closed';
      if (!inScope) return false;
      if (j.status === 'closed' && opts.skipJobNames?.has(jobName(j))) return false;
      return true;
    });

    for (const [jobIndex, job] of jobs.entries()) {
      const name = jobName(job);
      const url = `${BASE_URL}/${job.year}`;
      const html = HtmlResponse.parse(await this.fetcher(url));
      hooks.onProgress({
        source: this.name,
        job: name,
        jobsCompleted: jobIndex,
        jobsTotal: jobs.length,
        currentPage: 1,
        lastPage: 1,
      });
      const patches = parseSpanListingHtml(html);
      await hooks.onBatch(patches);
      await hooks.onJobDone?.(name);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend -- test/spanAdapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrapers/span/adapter.ts backend/test/spanAdapter.test.ts
git commit -m "feat(backend): add SpanAdapter with year-based open/archive job scraping"
```

---

### Task 7: Register `SpanAdapter` in the running server

**Files:**
- Modify: `backend/src/index.ts:1-15`

**Interfaces:**
- Consumes: `SpanAdapter` (Task 6), `createPoliteFetcher` with `responseType: 'text'`
  (Task 4).
- Produces: nothing new (this is pure wiring). Note: `src/index.ts` is excluded from
  coverage in `backend/vitest.config.ts` and has no dedicated test file today (the same is
  true for `MyProcurementAdapter`'s registration) — this task is verified by running the
  full suite and confirming the file still type-checks/imports cleanly, not by a new test.

- [ ] **Step 1: Add the import and registration**

In `backend/src/index.ts`, change:

```ts
import { MyProcurementAdapter } from './scrapers/myprocurement/adapter.js';
import { createPoliteFetcher } from './http/politeFetch.js';
```

to:

```ts
import { MyProcurementAdapter } from './scrapers/myprocurement/adapter.js';
import { SpanAdapter } from './scrapers/span/adapter.js';
import { createPoliteFetcher } from './http/politeFetch.js';
```

And change:

```ts
  const adapters = [new MyProcurementAdapter(createPoliteFetcher())];
```

to:

```ts
  const adapters = [
    new MyProcurementAdapter(createPoliteFetcher()),
    new SpanAdapter(createPoliteFetcher({ responseType: 'text' })),
  ];
```

- [ ] **Step 2: Run the full backend suite**

Run: `npm test -w backend`
Expected: PASS (all backend tests, including every earlier task's tests).

- [ ] **Step 3: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(backend): register SpanAdapter alongside MyProcurementAdapter"
```

---

### Task 8: Frontend displays a null `procurementType` as "—"

**Files:**
- Modify: `frontend/src/pages/TenderListPage.tsx:144`
- Modify: `frontend/src/pages/DetailPage.tsx:49`
- Test: `frontend/src/test/TenderListPage.test.tsx`
- Test: `frontend/src/test/DetailPage.test.tsx`

**Interfaces:**
- Consumes: `Tender['procurementType']` (now `... | null`, from Task 1) via `@tms/shared`.
- Produces: nothing new — display-only change.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/test/TenderListPage.test.tsx`. First, add `within` to the existing
`@testing-library/react` import on line 2:

```ts
import { render, screen, waitFor, within } from '@testing-library/react';
```

Then add this test inside `describe('TenderListPage', ...)`:

```ts
  it('renders "—" for a null procurementType', async () => {
    server.use(http.get('/api/tenders', () => HttpResponse.json({
      items: [makeTender({ procurementType: null })], total: 1, page: 1, pageSize: 20,
    })));
    renderList(<TenderListPage status="open" />);
    const row = (await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).closest('tr')!;
    expect(within(row).getByText('—')).toBeInTheDocument();
  });
```

Add to `frontend/src/test/DetailPage.test.tsx`, inside `describe('DetailPage', ...)`:

```ts
  it('shows "—" for Procurement Type when the source could not classify it', async () => {
    server.use(http.get('/api/tenders/:refNo', () => HttpResponse.json({
      tender: makeTender({ procurementType: null }),
    })));
    renderDetail('UTHM/54/P/02/023/2026');
    const label = await screen.findByText('Procurement Type');
    expect(label.nextElementSibling).toHaveTextContent('—');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w frontend -- TenderListPage`
Run: `npm test -w frontend -- DetailPage`
Expected: FAIL. `TenderListPage` renders an empty cell (no "—" text) for a null
`procurementType`; `DetailPage`'s `Field` component receives a truthy `<span>` element
wrapping empty text, so its `value ?? '—'` fallback never triggers and no "—" is rendered.

- [ ] **Step 3: Add the null fallbacks**

In `frontend/src/pages/TenderListPage.tsx:144`, change:

```tsx
                <td className="px-3 py-2 capitalize">{t.procurementType}</td>
```

to:

```tsx
                <td className="px-3 py-2 capitalize">{t.procurementType ?? '—'}</td>
```

In `frontend/src/pages/DetailPage.tsx:49`, change:

```tsx
        <Field label="Procurement Type" value={<span className="capitalize">{t.procurementType}</span>} />
```

to:

```tsx
        <Field
          label="Procurement Type"
          value={t.procurementType ? <span className="capitalize">{t.procurementType}</span> : null}
        />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w frontend -- TenderListPage`
Run: `npm test -w frontend -- DetailPage`
Expected: PASS (new tests, and every pre-existing test in both files).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/TenderListPage.tsx frontend/src/pages/DetailPage.tsx frontend/src/test/TenderListPage.test.tsx frontend/src/test/DetailPage.test.tsx
git commit -m "fix(frontend): show em-dash for an unclassifiable procurementType"
```

---

## Final verification

- [ ] Run the entire suite once more from the repo root: `npm test`
Expected: PASS across `shared`, `backend`, and `frontend` workspaces (this also re-runs
husky's pre-commit check equivalent, confirming nothing upstream regressed).
