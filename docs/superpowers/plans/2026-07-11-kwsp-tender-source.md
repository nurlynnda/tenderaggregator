# KWSP Tender Data Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add KWSP (kwsp.gov.my) as a third tender data source, scraping its single static HTML tenders page into the shared `Tender` schema, upserted by reference number so nothing is ever overwritten — only merged.

**Architecture:** A new `ScraperAdapter` (`backend/src/scrapers/kwsp/`) mirrors the existing `span` adapter's shape (plain HTML, no API). One HTTP fetch per `scrape()` call is split into two logical jobs — `open` (currently open tenders, rescraped every run) and `results` (the awarded-tenders archive, backfilled once). Parsing uses `cheerio`, same as `span`/`myprocurement`. No changes to the storage layer are needed — its existing upsert-by-`dedupKey` merge logic already guarantees the "not overwritten, only upserted" requirement.

**Tech Stack:** TypeScript (ESM), Express backend, `cheerio` for HTML parsing, `zod` for schema validation, `vitest` for tests.

## Global Constraints

- Write the failing test first, run it, confirm it fails for the right reason, then implement, then run again to confirm it passes. Never commit red.
- Commit immediately after each task goes green.
- Tests must never hit the real `kwsp.gov.my` — use the fixture file and injected fake fetchers only.
- Coverage thresholds (80% lines/branches) are enforced by vitest; don't lower them.
- All scrapers emit the shared `Tender`/`TenderPatch` schema (`shared/src/tender.ts`), Zod-validated; invalid records are logged and skipped, never stored.
- Cross-source dedup is by `dedupKey` (normalized `referenceNo`) — reuse `computeDedupKey` as-is, don't reimplement it.

Design reference: [`docs/superpowers/specs/2026-07-11-kwsp-tender-scraper-design.md`](../specs/2026-07-11-kwsp-tender-scraper-design.md)

---

### Task 1: Date-parsing helpers for KWSP's date formats

**Files:**
- Modify: `backend/src/parsing/text.ts`
- Test: `backend/test/text.test.ts`

**Interfaces:**
- Produces: `parseDottedDate(s: string | null | undefined): string | null` — parses a `dd.mm.yyyy` prefix (KWSP's "Open Date"/"Closing Date" format, e.g. `"06.07.2026 (Monday)"`) into `YYYY-MM-DD`, ignoring anything after the date (weekday, non-breaking-space padding). Returns `null` for invalid/missing input, same contract as the existing `parseDdMmYyyy`/`parseIsoDatePrefix`.
- Produces: `parseMonthYearToFirstOfMonth(s: string | null | undefined): string | null` — parses `"Month YYYY"` (e.g. `"March 2026"`) into the 1st of that month as `YYYY-MM-01`. Case-insensitive month name. Returns `null` for invalid/missing input.

- [ ] **Step 1: Write the failing tests**

Add to the end of `backend/test/text.test.ts`:

```ts
describe('parseDottedDate', () => {
  it('parses dd.mm.yyyy into ISO date, ignoring trailing weekday text', () => {
    expect(parseDottedDate('06.07.2026 (Monday)')).toBe('2026-07-06');
    expect(parseDottedDate('03.08.2026 (Monday)')).toBe('2026-08-03');
  });
  it('ignores a non-breaking space before the trailing weekday', () => {
    expect(parseDottedDate('23.07.2026 (Thursday)')).toBe('2026-07-23');
  });
  it('returns null for invalid or missing input', () => {
    expect(parseDottedDate('32.01.2026 (Friday)')).toBeNull(); // no day 32
    expect(parseDottedDate('30.02.2026 (Monday)')).toBeNull(); // no Feb 30
    expect(parseDottedDate('07/07/2026')).toBeNull(); // wrong separator
    expect(parseDottedDate('')).toBeNull();
    expect(parseDottedDate(null)).toBeNull();
    expect(parseDottedDate(undefined)).toBeNull();
  });
});

describe('parseMonthYearToFirstOfMonth', () => {
  it('parses "Month YYYY" into the 1st of that month', () => {
    expect(parseMonthYearToFirstOfMonth('March 2026')).toBe('2026-03-01');
    expect(parseMonthYearToFirstOfMonth('December 2025')).toBe('2025-12-01');
    expect(parseMonthYearToFirstOfMonth('January 2026')).toBe('2026-01-01');
  });
  it('is case-insensitive on the month name', () => {
    expect(parseMonthYearToFirstOfMonth('march 2026')).toBe('2026-03-01');
  });
  it('returns null for invalid or missing input', () => {
    expect(parseMonthYearToFirstOfMonth('Marchy 2026')).toBeNull();
    expect(parseMonthYearToFirstOfMonth('2026')).toBeNull();
    expect(parseMonthYearToFirstOfMonth('March')).toBeNull();
    expect(parseMonthYearToFirstOfMonth('')).toBeNull();
    expect(parseMonthYearToFirstOfMonth(null)).toBeNull();
    expect(parseMonthYearToFirstOfMonth(undefined)).toBeNull();
  });
});
```

Also update the import line at the top of the file:

```ts
import { describe, expect, it } from 'vitest';
import {
  parseDdMmYyyy, parseDottedDate, parseIsoDatePrefix, parseMonthYearToFirstOfMonth,
  parseRmPrice, splitFieldCodes,
} from '../src/parsing/text.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run test/text.test.ts`
Expected: FAIL — `parseDottedDate` and `parseMonthYearToFirstOfMonth` are not exported from `../src/parsing/text.js`.

- [ ] **Step 3: Implement the helpers**

Append to `backend/src/parsing/text.ts`:

```ts
export function parseDottedDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})/);
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

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export function parseMonthYearToFirstOfMonth(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const monthIndex = MONTH_NAMES.indexOf(m[1]!.toLowerCase());
  if (monthIndex === -1) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${m[2]}-${pad(monthIndex + 1)}-01`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run test/text.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add backend/src/parsing/text.ts backend/test/text.test.ts
git commit -m "feat(backend): add dotted-date and month-year date parsers for KWSP"
```

---

### Task 2: KWSP open-tenders parser

**Files:**
- Create: `backend/src/scrapers/kwsp/parseListing.ts`
- Test: `backend/test/kwspParseListing.test.ts`

**Interfaces:**
- Consumes: `parseDottedDate` from `../../parsing/text.js` (Task 1). `computeDedupKey`, `TenderPatchSchema`, `type TenderPatch` from `@tms/shared`.
- Produces: `parseOpenTenders(html: string, ctx?: { now?: () => string }): TenderPatch[]` — parses the "New Tenders Out" section of a KWSP tenders page into `TenderPatch[]`. Also produces the exported `KwspParseContext` interface (`{ now?: () => string }`), used again in Task 3.

- [ ] **Step 1: Write the failing tests**

Create `backend/test/kwspParseListing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TenderPatchSchema } from '@tms/shared';
import { parseOpenTenders } from '../src/scrapers/kwsp/parseListing.js';

const NOW = () => '2026-07-11T12:00:00.000Z';

const OPEN_CARD_HTML = `<div class="card-bg">
  <h4 class="component-heading"></h4>
  <h4 class="component-heading"></h4>
  <h4 class="component-heading">Cadangan Kerja-Kerja Penggantian Sistem Pam</h4>
  <div class="component-paragraph">
    <h4><span class="lead">Tender No.</span></h4>
    <ul><li><p>Doc5759801507</p></li></ul>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Qualification Criteria</span></h4>
    <div>CIDB Gred G4, M02/M15/M20/M22 and SPKK</div>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Open Date</span></h4>
    <ul><li>06.07.2026 (Monday)</li></ul>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Closing Date</span></h4>
    <ul><li><p>03.08.2026 (Monday)</p></li></ul>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Document Price</span></h4>
    <ul><li>Free</li></ul>
  </div>
  <a href="https://forms.office.com/r/hmX89dnb0U"><h6>Apply For Tender</h6></a>
  <a href="/documents/d/guest/c-3277-kwsp-na-artwork-1"><h6>More Info</h6></a>
</div>`;

describe('parseOpenTenders — embedded card, exact values', () => {
  it('extracts every field from an open-tender card, shaped as a TenderPatch', () => {
    const [t] = parseOpenTenders(OPEN_CARD_HTML, { now: NOW });
    expect(t).toBeDefined();
    expect(t!.referenceNo).toBe('Doc5759801507');
    expect(t!.dedupKey).toBe('DOC5759801507');
    expect(t!.title).toBe('Cadangan Kerja-Kerja Penggantian Sistem Pam');
    expect(t!.status).toBe('open');
    expect(t!.procurementType).toBe('tender');
    expect(t!.agency).toBe('Kumpulan Wang Simpanan Pekerja (KWSP)');
    expect(t!.advertisedDate).toBe('2026-07-06');
    expect(t!.closingDate).toBe('2026-08-03');
    expect(t!.source).toEqual({
      source: 'kwsp',
      sourceId: 'c-3277-kwsp-na-artwork-1',
      sourceUrl: 'https://www.kwsp.gov.my/documents/d/guest/c-3277-kwsp-na-artwork-1',
    });
    expect(t!.raw!['Tender No.']).toBe('Doc5759801507');
    expect(t!.raw!['Qualification Criteria']).toBe('CIDB Gred G4, M02/M15/M20/M22 and SPKK');
    expect(t!.scrapedAt).toBe('2026-07-11T12:00:00.000Z');
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('omits ministry/category/fieldCodes/indicativePrice/events/winners entirely (not observed by this source)', () => {
    const [t] = parseOpenTenders(OPEN_CARD_HTML, { now: NOW });
    expect(t).not.toHaveProperty('ministry');
    expect(t).not.toHaveProperty('category');
    expect(t).not.toHaveProperty('fieldCodes');
    expect(t).not.toHaveProperty('indicativePrice');
    expect(t).not.toHaveProperty('events');
    expect(t).not.toHaveProperty('winners');
  });

  it('falls back to the tenders page URL when the "More Info" link is missing', () => {
    const noLink = OPEN_CARD_HTML.replace(
      '<a href="/documents/d/guest/c-3277-kwsp-na-artwork-1"><h6>More Info</h6></a>', '',
    );
    const [t] = parseOpenTenders(noLink, { now: NOW });
    expect(t!.source.sourceUrl).toBe('https://www.kwsp.gov.my/en/corporate/procurement/tenders');
    expect(t!.source.sourceId).toBe('Doc5759801507');
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('skips a card with no title instead of throwing', () => {
    const noTitle = OPEN_CARD_HTML.replace('Cadangan Kerja-Kerja Penggantian Sistem Pam', '');
    expect(parseOpenTenders(noTitle, { now: NOW })).toEqual([]);
  });

  it('skips a card with no "Tender No." field instead of throwing', () => {
    const noRef = OPEN_CARD_HTML.replace('<span class="lead">Tender No.</span>', '<span class="lead">Tender Ref</span>');
    expect(parseOpenTenders(noRef, { now: NOW })).toEqual([]);
  });

  it('excludes a Tender Results card-bg (containing an accordion-card) from open tenders', () => {
    const resultsCard = `<div class="card-bg"><div class="accordion-card"></div></div>`;
    expect(parseOpenTenders(OPEN_CARD_HTML + resultsCard, { now: NOW })).toHaveLength(1);
  });

  it('falls back to Date.now() when ctx.now is not provided', () => {
    const [t] = parseOpenTenders(OPEN_CARD_HTML);
    expect(typeof t!.scrapedAt).toBe('string');
    expect(t!.scrapedAt.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run test/kwspParseListing.test.ts`
Expected: FAIL — cannot find module `../src/scrapers/kwsp/parseListing.js`.

- [ ] **Step 3: Implement the parser**

Create `backend/src/scrapers/kwsp/parseListing.ts`:

```ts
import * as cheerio from 'cheerio';
import type { AnyNode, Cheerio } from 'cheerio';
import { TenderPatchSchema, computeDedupKey, type TenderPatch } from '@tms/shared';
import { parseDottedDate } from '../../parsing/text.js';

export interface KwspParseContext {
  now?: () => string;
}

const SOURCE = 'kwsp';
const AGENCY = 'Kumpulan Wang Simpanan Pekerja (KWSP)';
const PAGE_URL = 'https://www.kwsp.gov.my/en/corporate/procurement/tenders';

export function parseOpenTenders(html: string, ctx: KwspParseContext = {}): TenderPatch[] {
  const $ = cheerio.load(html);
  const now = ctx.now ?? (() => new Date().toISOString());
  const scrapedAt = now();
  const patches: TenderPatch[] = [];

  $('div.card-bg').each((_, el) => {
    const card = $(el);
    if (card.find('.accordion-card').length > 0) return; // a Tender Results card, not an open tender
    const candidate = parseOpenCard($, card, scrapedAt);
    if (!candidate) return;
    const result = TenderPatchSchema.safeParse(candidate);
    if (!result.success) {
      console.warn(`[kwsp] skipping invalid open tender card: ${result.error.message}`);
      return;
    }
    patches.push(result.data);
  });

  return patches;
}

function parseOpenCard(
  $: cheerio.CheerioAPI,
  card: Cheerio<AnyNode>,
  scrapedAt: string,
): Record<string, unknown> | null {
  const title = clean(
    card.find('h4.component-heading').filter((_, h) => clean($(h).text()).length > 0).first().text(),
  );
  if (!title) return null;

  const referenceNo = fieldValue($, card, 'Tender No.');
  if (!referenceNo) return null;

  const qualificationCriteria = fieldValue($, card, 'Qualification Criteria');
  const openDateText = fieldValue($, card, 'Open Date');
  const closingDateText = fieldValue($, card, 'Closing Date');
  const documentPrice = fieldValue($, card, 'Document Price');

  const moreInfoLink = card.find('a').filter((_, a) => clean($(a).text()) === 'More Info').first();
  const href = moreInfoLink.attr('href') ?? '';
  const sourceUrl = href ? new URL(href, PAGE_URL).toString() : PAGE_URL;
  const sourceId = href.split('/').filter((seg) => seg.length > 0).pop() ?? referenceNo;

  const raw: Record<string, string> = { 'Tender No.': referenceNo, Title: title };
  if (qualificationCriteria) raw['Qualification Criteria'] = qualificationCriteria;
  if (openDateText) raw['Open Date'] = openDateText;
  if (closingDateText) raw['Closing Date'] = closingDateText;
  if (documentPrice) raw['Document Price'] = documentPrice;

  const fallback = `${SOURCE}:${sourceId}`;
  return {
    dedupKey: computeDedupKey(referenceNo, fallback),
    referenceNo,
    title,
    status: 'open',
    procurementType: 'tender',
    scrapedAt,
    source: { source: SOURCE, sourceId, sourceUrl },
    agency: AGENCY,
    advertisedDate: parseDottedDate(openDateText),
    closingDate: parseDottedDate(closingDateText),
    raw,
  };
}

function fieldValue($: cheerio.CheerioAPI, card: Cheerio<AnyNode>, label: string): string {
  const container = card.find('.component-paragraph').filter(
    (_, el) => clean($(el).find('.lead').first().text()) === label,
  ).first();
  if (container.length === 0) return '';
  const clone = container.clone();
  clone.find('h4').remove();
  return clean(clone.text());
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run test/kwspParseListing.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrapers/kwsp/parseListing.ts backend/test/kwspParseListing.test.ts
git commit -m "feat(backend): parse KWSP's open-tenders section into TenderPatch records"
```

---

### Task 3: KWSP tender-results parser

**Files:**
- Modify: `backend/src/scrapers/kwsp/parseListing.ts`
- Modify: `backend/test/kwspParseListing.test.ts`

**Interfaces:**
- Consumes: `parseMonthYearToFirstOfMonth` from `../../parsing/text.js` (Task 1); `KwspParseContext`, `SOURCE`, `AGENCY`, `PAGE_URL`, `clean` (Task 2, same file).
- Produces: `parseResults(html: string, ctx?: KwspParseContext): TenderPatch[]` — parses the "Tender Results" archive into `TenderPatch[]`. Also produces `KwspParsedListing` (`{ open: TenderPatch[]; results: TenderPatch[] }`) and the combining `parseKwspListingHtml(html: string, ctx?: KwspParseContext): KwspParsedListing`, which Task 5 (the adapter) consumes.

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/kwspParseListing.test.ts` (add `parseResults` to the existing import line, changing it to `import { parseOpenTenders, parseResults } from '../src/scrapers/kwsp/parseListing.js';`):

```ts
const RESULTS_HTML = `<div class="card-bg">
  <div class="accordion-card">
    <div class="accordion-item">
      <div class="accordion-header"><h3>March 2026</h3></div>
      <div class="accordion-content">
        <p>Cadangan Kerja-Kerja Penggantian Pam Di EPF Learning Campus<br> <em>Doc5446704109<br> MEDIINA WAWASAN RESOURCES</em></p>
      </div>
    </div>
    <div class="accordion-item">
      <div class="accordion-header"><h3>November 2025</h3></div>
      <div class="accordion-content">
        <p>Perkhidmatan Penghantaran Khidmat Pesanan Ringkas (SMS)<br> <em>Doc5248683420<br> Maxis Broadband Sdn Bhd<br> Celcom Berhad</em></p>
      </div>
    </div>
  </div>
</div>`;

const MALFORMED_RESULT_HTML = `<div class="card-bg">
  <div class="accordion-card">
    <div class="accordion-item">
      <div class="accordion-header"><h3>March 2026</h3></div>
      <div class="accordion-content">
        <p>Title With No Reference Block At All</p>
      </div>
    </div>
  </div>
</div>`;

describe('parseResults — embedded entries, exact values', () => {
  it('extracts a single-winner result entry, shaped as a TenderPatch', () => {
    const results = parseResults(RESULTS_HTML, { now: NOW });
    const t = results.find((r) => r.referenceNo === 'Doc5446704109');
    expect(t).toBeDefined();
    expect(t!.title).toBe('Cadangan Kerja-Kerja Penggantian Pam Di EPF Learning Campus');
    expect(t!.status).toBe('closed');
    expect(t!.procurementType).toBe('tender');
    expect(t!.agency).toBe('Kumpulan Wang Simpanan Pekerja (KWSP)');
    expect(t!.dedupKey).toBe('DOC5446704109');
    expect(t!.closingDate).toBe('2026-03-01');
    expect(t!.winners).toEqual([{ name: 'MEDIINA WAWASAN RESOURCES', price: null }]);
    expect(t!.source).toEqual({
      source: 'kwsp', sourceId: 'Doc5446704109',
      sourceUrl: 'https://www.kwsp.gov.my/en/corporate/procurement/tenders',
    });
    expect(t).not.toHaveProperty('advertisedDate');
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('splits multiple winners on <br> within the reference/winner block', () => {
    const results = parseResults(RESULTS_HTML, { now: NOW });
    const t = results.find((r) => r.referenceNo === 'Doc5248683420');
    expect(t!.winners).toEqual([
      { name: 'Maxis Broadband Sdn Bhd', price: null },
      { name: 'Celcom Berhad', price: null },
    ]);
    expect(t!.closingDate).toBe('2025-11-01');
  });

  it('omits winners entirely (not []) when the reference block has no winner name', () => {
    const noWinnerName = RESULTS_HTML.replace(
      'Doc5446704109<br> MEDIINA WAWASAN RESOURCES', 'Doc5446704109',
    );
    const results = parseResults(noWinnerName, { now: NOW });
    const t = results.find((r) => r.referenceNo === 'Doc5446704109');
    expect(t).toBeDefined();
    expect(t).not.toHaveProperty('winners');
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('skips a result entry with no reference/winner block instead of throwing', () => {
    expect(parseResults(MALFORMED_RESULT_HTML, { now: NOW })).toEqual([]);
  });

  it('falls back to Date.now() when ctx.now is not provided', () => {
    const [t] = parseResults(RESULTS_HTML);
    expect(typeof t!.scrapedAt).toBe('string');
    expect(t!.scrapedAt.length).toBeGreaterThan(0);
  });
});

describe('parseOpenTenders / parseResults — kept separate in the same document', () => {
  it('does not let a Tender Results card leak into open tenders, or vice versa', () => {
    const combined = OPEN_CARD_HTML + RESULTS_HTML;
    expect(parseOpenTenders(combined, { now: NOW })).toHaveLength(1);
    expect(parseResults(combined, { now: NOW })).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run test/kwspParseListing.test.ts`
Expected: FAIL — `parseResults` is not exported from `../src/scrapers/kwsp/parseListing.js`.

- [ ] **Step 3: Implement the results parser**

In `backend/src/scrapers/kwsp/parseListing.ts`, change the import line to also pull in `parseMonthYearToFirstOfMonth`:

```ts
import { parseDottedDate, parseMonthYearToFirstOfMonth } from '../../parsing/text.js';
```

Then append to the end of the file:

```ts
export interface KwspParsedListing {
  open: TenderPatch[];
  results: TenderPatch[];
}

export function parseKwspListingHtml(html: string, ctx: KwspParseContext = {}): KwspParsedListing {
  return { open: parseOpenTenders(html, ctx), results: parseResults(html, ctx) };
}

export function parseResults(html: string, ctx: KwspParseContext = {}): TenderPatch[] {
  const $ = cheerio.load(html);
  const now = ctx.now ?? (() => new Date().toISOString());
  const scrapedAt = now();
  const patches: TenderPatch[] = [];

  $('.accordion-card .accordion-item').each((_, item) => {
    const monthLabel = clean($(item).find('h3').first().text());
    const closingDate = parseMonthYearToFirstOfMonth(monthLabel);
    $(item).find('.accordion-content > p').each((_, p) => {
      const candidate = parseResultEntry($, $(p), monthLabel, closingDate, scrapedAt);
      if (!candidate) return;
      const result = TenderPatchSchema.safeParse(candidate);
      if (!result.success) {
        console.warn(`[kwsp] skipping invalid tender result: ${result.error.message}`);
        return;
      }
      patches.push(result.data);
    });
  });

  return patches;
}

function parseResultEntry(
  $: cheerio.CheerioAPI,
  p: Cheerio<AnyNode>,
  monthLabel: string,
  closingDate: string | null,
  scrapedAt: string,
): Record<string, unknown> | null {
  const title = clean(p.contents().first().text());
  if (!title) return null;

  const emEl = p.find('em').first();
  if (emEl.length === 0) return null;
  const emParts = splitByBr($, emEl);
  const referenceNo = emParts[0] ?? '';
  if (!referenceNo) return null;
  const winnerNames = emParts.slice(1);

  const raw: Record<string, string> = { Title: title, 'Tender No.': referenceNo };
  if (monthLabel) raw['Result Month'] = monthLabel;
  if (winnerNames.length > 0) raw['Winners'] = winnerNames.join('; ');

  const fallback = `${SOURCE}:${referenceNo}`;
  const patch: Record<string, unknown> = {
    dedupKey: computeDedupKey(referenceNo, fallback),
    referenceNo,
    title,
    status: 'closed',
    procurementType: 'tender',
    scrapedAt,
    source: { source: SOURCE, sourceId: referenceNo, sourceUrl: PAGE_URL },
    agency: AGENCY,
    closingDate,
    raw,
  };
  if (winnerNames.length > 0) {
    patch.winners = winnerNames.map((name) => ({ name, price: null }));
  }
  return patch;
}

function splitByBr($: cheerio.CheerioAPI, el: Cheerio<AnyNode>): string[] {
  const segments: string[] = [];
  let current = '';
  el.contents().each((_, node) => {
    if ((node as { type?: string }).type === 'tag' && (node as { tagName?: string }).tagName === 'br') {
      segments.push(current);
      current = '';
    } else {
      current += $(node).text();
    }
  });
  segments.push(current);
  return segments.map((s) => clean(s)).filter((s) => s.length > 0);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run test/kwspParseListing.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrapers/kwsp/parseListing.ts backend/test/kwspParseListing.test.ts
git commit -m "feat(backend): parse KWSP's Tender Results archive into TenderPatch records"
```

---

### Task 4: Live fixture + structural invariant test

**Files:**
- Create: `backend/test/fixtures/kwsp-tenders.html`
- Modify: `backend/test/kwspParseListing.test.ts`

**Interfaces:**
- Consumes: `parseKwspListingHtml` (Task 3).

- [ ] **Step 1: Create the fixture**

Create `backend/test/fixtures/kwsp-tenders.html`:

```html
<div class="card-bg">
  <h4 class="component-heading"></h4>
  <h4 class="component-heading"></h4>
  <h4 class="component-heading">Cadangan Kerja-Kerja Penggantian Sistem Pam Dan Tangki Air Termasuk Pam Jockey, Sprinkler, Domestik Dan Kerja Berkaitan Di Bangunan KWSP Cawangan Seberang Jaya, Kota Bharu, Kuala Terengganu, Kuantan, Ipoh Dan ELC.</h4>
  <div class="component-paragraph">
    <h4><span class="lead">Tender No.</span></h4>
    <ul><li><p>Doc5759801507</p></li></ul>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Qualification Criteria</span></h4>
    <div>&nbsp; &nbsp; &nbsp;.&nbsp; CIDB Gred G4, M02/M15/ M20/M22 and SPKK</div>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Open Date</span></h4>
    <ul><li>06.07.2026 (Monday)</li></ul>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Closing Date</span></h4>
    <ul><li><p>03.08.2026 (Monday)</p></li></ul>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Document Price</span></h4>
    <ul><li>Free</li></ul>
  </div>
  <a href="https://forms.office.com/r/hmX89dnb0U"><h6>Apply For Tender</h6></a>
  <a href="/documents/d/guest/c-3277-kwsp-na-artwork-1"><h6>More Info</h6></a>
</div>

<div class="card-bg">
  <h4 class="component-heading"></h4>
  <h4 class="component-heading"></h4>
  <h4 class="component-heading">Testing As A Services</h4>
  <div class="component-paragraph">
    <h4><span class="lead">Tender No.</span></h4>
    <ul><li><p>Doc5731829168</p></li></ul>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Open Date</span></h4>
    <ul><li>02.07.2026&nbsp;(Thursday)</li></ul>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Closing Date</span></h4>
    <ul><li><p>23.07.2026&nbsp;(Thursday)</p></li></ul>
  </div>
  <a href="https://forms.office.com/r/hmX89dnb0U"><h6>Apply For Tender</h6></a>
  <a href="/documents/d/guest/tender-01022026"><h6>More Info</h6></a>
</div>

<div class="card-bg">
  <h4 class="component-heading"></h4>
  <h4 class="component-heading">Malformed Card Missing Tender Number</h4>
  <div class="component-paragraph">
    <h4><span class="lead">Open Date</span></h4>
    <ul><li>01.01.2026 (Thursday)</li></ul>
  </div>
</div>

<div class="card-bg">
  <h4 class="component-heading">2026</h4>
  <div class="accordion-card">
    <div class="accordion-item">
      <div class="accordion-header"><h3>March 2026</h3></div>
      <div class="accordion-content">
        <p>Cadangan Kerja-Kerja Penggantian Pam (Chilled Water, Condenser Water &amp; STP) Di EPF Learning Campus (ELC) &amp; Bangunan KWSP Melaka<br> <em style="font-family:'Courier New'">Doc5446704109<br> MEDIINA WAWASAN RESOURCES</em></p>
      </div>
    </div>
    <div class="accordion-item">
      <div class="accordion-header"><h3>November 2025</h3></div>
      <div class="accordion-content">
        <p>Perkhidmatan Penghantaran Khidmat Pesanan Ringkas (SMS) - eCommunication Management System<br> <em style="font-family:'Courier New'">Doc5248683420<br> Maxis Broadband Sdn Bhd<br> Celcom Berhad</em></p>
        <hr>
        <p>Malformed Result Missing Reference Block</p>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Write the failing test**

Append to `backend/test/kwspParseListing.test.ts`. First add the necessary imports at the top of the file (extend the existing `vitest` and local imports, and add the two new ones):

```ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKwspListingHtml } from '../src/scrapers/kwsp/parseListing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
```

Then add:

```ts
describe('parseKwspListingHtml — live fixture, structural invariants', () => {
  it('parses every open card and result entry in the fixture into schema-valid patches', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'kwsp-tenders.html'), 'utf8');
    const { open, results } = parseKwspListingHtml(html, { now: NOW });
    expect(open).toHaveLength(2); // third card is missing "Tender No." and is skipped
    expect(results).toHaveLength(2); // the malformed entry with no <em> block is skipped

    for (const t of [...open, ...results]) {
      expect(() => TenderPatchSchema.parse(t)).not.toThrow();
      expect(t.source.source).toBe('kwsp');
      if (t.advertisedDate) expect(t.advertisedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (t.closingDate) expect(t.closingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(open.every((t) => t.status === 'open')).toBe(true);
    expect(results.every((t) => t.status === 'closed')).toBe(true);
    expect(new Set([...open, ...results].map((t) => t.dedupKey)).size).toBe(4);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && npx vitest run test/kwspParseListing.test.ts`
Expected: FAIL — `parseKwspListingHtml` is not exported, or the fixture file doesn't exist yet (both should already be in place from Step 1 above and Task 3, so this should actually already pass; run it to confirm before moving on — if it fails for any *other* reason, that's a real bug to fix before proceeding).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx vitest run test/kwspParseListing.test.ts`
Expected: PASS (all tests in the file — this task adds no new source code, only the fixture and its test).

- [ ] **Step 5: Commit**

```bash
git add backend/test/fixtures/kwsp-tenders.html backend/test/kwspParseListing.test.ts
git commit -m "test(backend): add live-fixture structural test for KWSP parsing"
```

---

### Task 5: KWSP adapter

**Files:**
- Create: `backend/src/scrapers/kwsp/adapter.ts`
- Test: `backend/test/kwspAdapter.test.ts`

**Interfaces:**
- Consumes: `parseKwspListingHtml` (Task 3); `ScrapeHooks`, `ScrapeOptions`, `ScrapeScope`, `ScraperAdapter` from `../types.js`.
- Produces: `class KwspAdapter implements ScraperAdapter` — `name = 'kwsp'`, constructor takes `(fetcher: (url: string) => Promise<unknown>)`, consumed by Task 6 (`index.ts` wiring).

- [ ] **Step 1: Write the failing tests**

Create `backend/test/kwspAdapter.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { TenderPatch } from '@tms/shared';
import { KwspAdapter } from '../src/scrapers/kwsp/adapter.js';

const PAGE_URL = 'https://www.kwsp.gov.my/en/corporate/procurement/tenders';

const OPEN_TENDER_HTML = `<div class="card-bg">
  <h4 class="component-heading"></h4>
  <h4 class="component-heading"></h4>
  <h4 class="component-heading">Sample Open Tender</h4>
  <div class="component-paragraph">
    <h4><span class="lead">Tender No.</span></h4>
    <ul><li><p>Doc1000000001</p></li></ul>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Open Date</span></h4>
    <ul><li>01.07.2026 (Wednesday)</li></ul>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Closing Date</span></h4>
    <ul><li><p>15.07.2026 (Wednesday)</p></li></ul>
  </div>
  <a href="/documents/d/guest/sample-open-tender"><h6>More Info</h6></a>
</div>`;

const RESULT_HTML = `<div class="card-bg">
  <div class="accordion-card">
    <div class="accordion-item">
      <div class="accordion-header"><h3>July 2026</h3></div>
      <div class="accordion-content">
        <p>Sample Result Tender<br> <em>Doc2000000002<br> Winner Sdn Bhd</em></p>
      </div>
    </div>
  </div>
</div>`;

const PAGE_HTML = OPEN_TENDER_HTML + RESULT_HTML;

describe('KwspAdapter — job model', () => {
  it('reports "results" as the only archive job', () => {
    const adapter = new KwspAdapter(vi.fn());
    expect(adapter.archiveJobNames()).toEqual(['results']);
  });

  it('scope=open fetches the page once and emits only the open job', async () => {
    const fetcher = vi.fn(async () => PAGE_HTML);
    const adapter = new KwspAdapter(fetcher);
    const batches: TenderPatch[][] = [];
    const done: string[] = [];
    await adapter.scrape('open', {
      onProgress: () => {}, onBatch: async (t) => { batches.push(t); }, onJobDone: (n) => done.push(n),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(PAGE_URL);
    expect(done).toEqual(['open']);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((t) => t.referenceNo)).toEqual(['Doc1000000001']);
  });

  it('scope=archive fetches the page once and emits only the results job', async () => {
    const fetcher = vi.fn(async () => PAGE_HTML);
    const adapter = new KwspAdapter(fetcher);
    const batches: TenderPatch[][] = [];
    const done: string[] = [];
    await adapter.scrape('archive', {
      onProgress: () => {}, onBatch: async (t) => { batches.push(t); }, onJobDone: (n) => done.push(n),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(done).toEqual(['results']);
    expect(batches[0]!.map((t) => t.referenceNo)).toEqual(['Doc2000000002']);
  });

  it('scope=all fetches the page exactly once and emits both jobs in order', async () => {
    const fetcher = vi.fn(async () => PAGE_HTML);
    const adapter = new KwspAdapter(fetcher);
    const done: string[] = [];
    await adapter.scrape('all', { onProgress: () => {}, onBatch: async () => {}, onJobDone: (n) => done.push(n) });
    expect(fetcher).toHaveBeenCalledTimes(1); // one page fetch serves both jobs, not two
    expect(done).toEqual(['open', 'results']);
  });

  it('skips the results job (and never fetches) when already backfilled and scope=archive', async () => {
    const fetcher = vi.fn(async () => PAGE_HTML);
    const adapter = new KwspAdapter(fetcher);
    const onBatch = vi.fn(async () => {});
    await adapter.scrape('archive', { onProgress: () => {}, onBatch }, { skipJobNames: new Set(['results']) });
    expect(fetcher).not.toHaveBeenCalled();
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('still fetches once for the open job even when results is already backfilled, scope=all', async () => {
    const fetcher = vi.fn(async () => PAGE_HTML);
    const adapter = new KwspAdapter(fetcher);
    const done: string[] = [];
    await adapter.scrape('all', { onProgress: () => {}, onBatch: async () => {}, onJobDone: (n) => done.push(n) }, {
      skipJobNames: new Set(['results']),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(done).toEqual(['open']);
  });

  it('reports progress with jobsTotal reflecting only the in-scope jobs', async () => {
    const fetcher = vi.fn(async () => PAGE_HTML);
    const adapter = new KwspAdapter(fetcher);
    const progress: unknown[] = [];
    await adapter.scrape('all', { onProgress: (p) => progress.push({ ...p }), onBatch: async () => {} });
    expect(progress).toEqual([
      { source: 'kwsp', job: 'open', jobsCompleted: 0, jobsTotal: 2, currentPage: 1, lastPage: 1 },
      { source: 'kwsp', job: 'results', jobsCompleted: 1, jobsTotal: 2, currentPage: 1, lastPage: 1 },
    ]);
  });

  it('rejects when the fetcher fails, without calling onBatch', async () => {
    const fetcher = vi.fn(async () => { throw new Error('fetch failed after 3 attempts: x'); });
    const adapter = new KwspAdapter(fetcher);
    const onBatch = vi.fn(async () => {});
    await expect(adapter.scrape('open', { onProgress: () => {}, onBatch })).rejects.toThrow('fetch failed');
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('stops before the results job when isCancelled reports true, without throwing', async () => {
    const fetcher = vi.fn(async () => PAGE_HTML);
    const adapter = new KwspAdapter(fetcher);
    let cancelAfterFirst = false;
    const done: string[] = [];
    await adapter.scrape('all', {
      onProgress: () => {},
      onBatch: async () => { cancelAfterFirst = true; },
      onJobDone: (n) => done.push(n),
    }, { isCancelled: () => cancelAfterFirst });
    expect(done).toEqual(['open']);
    expect(fetcher).toHaveBeenCalledTimes(1); // cancellation only stops the job loop, not the shared fetch
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run test/kwspAdapter.test.ts`
Expected: FAIL — cannot find module `../src/scrapers/kwsp/adapter.js`.

- [ ] **Step 3: Implement the adapter**

Create `backend/src/scrapers/kwsp/adapter.ts`:

```ts
import { z } from 'zod';
import type { ScrapeHooks, ScrapeOptions, ScrapeScope, ScraperAdapter } from '../types.js';
import { parseKwspListingHtml } from './parseListing.js';

const PAGE_URL = 'https://www.kwsp.gov.my/en/corporate/procurement/tenders';

const HtmlResponse = z.string().min(1);

type KwspJobName = 'open' | 'results';

interface KwspJob {
  name: KwspJobName;
  status: 'open' | 'closed';
}

const JOBS: KwspJob[] = [
  { name: 'open', status: 'open' },
  { name: 'results', status: 'closed' },
];

export class KwspAdapter implements ScraperAdapter {
  readonly name = 'kwsp';

  constructor(private readonly fetcher: (url: string) => Promise<unknown>) {}

  archiveJobNames(): string[] {
    return JOBS.filter((j) => j.status === 'closed').map((j) => j.name);
  }

  async scrape(scope: ScrapeScope, hooks: ScrapeHooks, opts: ScrapeOptions = {}): Promise<void> {
    const jobs = JOBS.filter((j) => {
      const inScope = scope === 'all' ? true : scope === 'open' ? j.status === 'open' : j.status === 'closed';
      if (!inScope) return false;
      if (j.status === 'closed' && opts.skipJobNames?.has(j.name)) return false; // already backfilled
      return true;
    });
    if (jobs.length === 0) return;
    if (opts.isCancelled?.()) return;

    const html = HtmlResponse.parse(await this.fetcher(PAGE_URL));
    const { open, results } = parseKwspListingHtml(html);

    for (const [jobIndex, job] of jobs.entries()) {
      if (opts.isCancelled?.()) return;
      hooks.onProgress({
        source: this.name,
        job: job.name,
        jobsCompleted: jobIndex,
        jobsTotal: jobs.length,
        currentPage: 1,
        lastPage: 1,
      });
      const patches = job.name === 'open' ? open : results;
      await hooks.onBatch(patches);
      await hooks.onJobDone?.(job.name);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run test/kwspAdapter.test.ts`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrapers/kwsp/adapter.ts backend/test/kwspAdapter.test.ts
git commit -m "feat(backend): add KwspAdapter with a shared-fetch open/results job model"
```

---

### Task 6: Wire KwspAdapter into the running server

**Files:**
- Modify: `backend/src/index.ts:1-31`

**Interfaces:**
- Consumes: `KwspAdapter` (Task 5), `createPoliteFetcher` (existing, from `./http/politeFetch.js`).

- [ ] **Step 1: Register the adapter**

In `backend/src/index.ts`, add the import alongside the existing adapter imports (after line 2, `import { SpanAdapter } from './scrapers/span/adapter.js';`):

```ts
import { KwspAdapter } from './scrapers/kwsp/adapter.js';
```

Then update the `adapters` array (currently at lines 27-30):

```ts
  const adapters = [
    new MyProcurementAdapter(createPoliteFetcher()),
    new SpanAdapter(createPoliteFetcher({ responseType: 'text', fetchImpl: createSpanFetchImpl() })),
    new KwspAdapter(createPoliteFetcher({ responseType: 'text' })),
  ];
```

- [ ] **Step 2: Run the full backend test suite to confirm nothing broke**

Run: `cd backend && npx vitest run`
Expected: PASS (all existing tests still pass — this task changes no tested logic, only wiring; `index.ts` itself has no direct test file in this codebase).

- [ ] **Step 3: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(backend): register KwspAdapter alongside myprocurement and span"
```

---

### Task 7: Repository regression test — KWSP open-to-results upsert safety

**Files:**
- Modify: `backend/test/repository.test.ts`

**Interfaces:**
- Consumes: `TenderRepository`, `makePatch` (both already defined in this test file).

This is the concrete test for the design's core requirement: when a KWSP tender that started as an open listing later shows up in the Tender Results archive (same `dedupKey`, since both sections share the same `Doc...` numbering), the results patch's `status`/`winners`/`closingDate` update the record, but a field the results patch never observed (`advertisedDate`) must survive untouched from the earlier open patch.

- [ ] **Step 1: Write the failing test**

Add to `backend/test/repository.test.ts`, in the `describe('TenderRepository', ...)` block (e.g. right after the existing "never lets a different source without fieldCodes/winners erase..." test):

```ts
  it('KWSP: preserves an open tender\'s advertisedDate when a later results patch (same dedupKey) never observed it, while updating status/closingDate/winners', async () => {
    const { repo } = freshRepo();
    await repo.load();
    const openSource = {
      source: 'kwsp', sourceId: 'sample-doc',
      sourceUrl: 'https://www.kwsp.gov.my/documents/d/guest/sample-doc',
    };
    const resultsSource = {
      source: 'kwsp', sourceId: 'Doc1234567890',
      sourceUrl: 'https://www.kwsp.gov.my/en/corporate/procurement/tenders',
    };
    repo.mergeMany([makePatch({
      dedupKey: 'DOC1234567890', referenceNo: 'Doc1234567890', title: 'Sample KWSP Tender',
      procurementType: 'tender',
      advertisedDate: '2026-07-01', closingDate: '2026-07-15',
      scrapedAt: '2026-07-01T00:00:00.000Z', source: openSource,
    })]);
    repo.mergeMany([makePatch({
      dedupKey: 'DOC1234567890', referenceNo: 'Doc1234567890', title: 'Sample KWSP Tender',
      status: 'closed', procurementType: 'tender', closingDate: '2026-08-01',
      scrapedAt: '2026-08-05T00:00:00.000Z', source: resultsSource,
      winners: [{ name: 'Winner Sdn Bhd', price: null }],
    })]);
    const [t] = repo.getAll();
    expect(t!.status).toBe('closed');
    expect(t!.winners).toEqual([{ name: 'Winner Sdn Bhd', price: null }]);
    expect(t!.closingDate).toBe('2026-08-01'); // the results patch's own (newer) value wins
    expect(t!.advertisedDate).toBe('2026-07-01'); // never observed by the results patch — untouched
    expect(t!.sources).toEqual([resultsSource]);
  });
```

- [ ] **Step 2: Run the test to verify it fails or already passes**

Run: `cd backend && npx vitest run test/repository.test.ts`
Expected: PASS — this test exercises only pre-existing, already-correct `TenderRepository` merge logic (no source code changes are needed for it; the repository's upsert behavior was built generically enough to cover this case already). Confirm it's green; if it fails, that's a real bug in `backend/src/storage/repository.ts`'s merge logic that must be fixed before proceeding (do not weaken the test to make it pass).

- [ ] **Step 3: Commit**

```bash
git add backend/test/repository.test.ts
git commit -m "test(backend): verify KWSP open-to-results upsert never overwrites unobserved fields"
```

---

## Final verification

- [ ] **Run the full workspace test suite**

Run (from repo root): `npm test`
Expected: All workspaces (`shared`, `backend`, `frontend`) pass, coverage thresholds met.
