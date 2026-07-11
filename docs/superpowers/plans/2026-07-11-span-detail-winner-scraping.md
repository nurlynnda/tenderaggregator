# SPAN Detail-Page Winner Scraping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the `winners` field (`[{ name, price }]`) for SPAN's closed tenders by fetching each one's detail page (`/tender/view/:id`) and parsing the "who won and for how much" block out of its freeform HTML.

**Architecture:** A new pure parser function, `parseSpanDetailWinners(html)`, extracts winners from one detail page's HTML by scanning table rows for a `Nama Pembekal`/`Harga Tawaran` label pair. `SpanAdapter.scrape()` calls it once per closed tender in a job (after the existing listing fetch/parse/batch, before `onJobDone`), reusing the same rate-limited fetcher already wired up for listing pages. A failed detail fetch for one tender is logged and skipped, not fatal to the job.

**Tech Stack:** TypeScript (ESM), cheerio for HTML parsing, vitest for tests. No new dependencies.

## Global Constraints

- Node 22, TypeScript, ESM everywhere (`.js` extensions on relative imports, matching every existing file in `backend/src/scrapers/span/`).
- TDD non-negotiable: write the failing test first, confirm it fails for the right reason, write minimal implementation, confirm it passes, commit immediately after green — never commit red.
- Tests must never hit the real `span.gov.my` — every test in this plan uses fixtures/embedded HTML strings and injected fake fetchers only.
- Coverage thresholds (80% lines/branches) are enforced by vitest; pre-commit runs the full workspace suite (`npm test`) — do not lower thresholds or skip hooks.

---

## File Structure

- **Create:** `backend/src/scrapers/span/parseDetail.ts` — the new `parseSpanDetailWinners(html)` parser. One responsibility: turn one detail page's HTML into a `Winner[]`.
- **Create:** `backend/test/spanParseDetail.test.ts` — unit tests for the parser, using real (trimmed) HTML captured from `span.gov.my` on 2026-07-11.
- **Modify:** `backend/src/scrapers/span/adapter.ts` — add the per-closed-tender detail-fetch loop inside `scrape()`.
- **Modify:** `backend/test/spanAdapter.test.ts` — add adapter-level tests for the new wiring (which tenders get fetched, failure handling, cancellation, progress reporting).

---

### Task 1: Detail-page winner parser

**Files:**
- Create: `backend/src/scrapers/span/parseDetail.ts`
- Test: `backend/test/spanParseDetail.test.ts`

**Interfaces:**
- Consumes: `Winner` type from `@tms/shared` (`{ name: string, price: number | null }`, already defined in `shared/src/tender.ts`); `parseRmPrice(s: string | null | undefined): number | null` from `backend/src/parsing/text.ts` (already exists, used by `backend/src/scrapers/myprocurement/parseResults.ts`).
- Produces: `parseSpanDetailWinners(html: string): Winner[]` — the only export. Task 2 imports this exact name and signature from `./parseDetail.js`.

- [ ] **Step 1: Write the failing test file**

Create `backend/test/spanParseDetail.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseSpanDetailWinners } from '../src/scrapers/span/parseDetail.js';

// Real winner block from span.gov.my/tender/view/147 (captured 2026-07-11), trimmed to
// two of the four "all bidders" rows plus the full KEPUTUSAN (result) winner table — the
// bidder rows prove those don't get mistaken for winner rows.
const ADJACENT_CELLS_WITH_BIDDER_TABLE = `<table cellspacing="0" cellpadding="0" style="margin:20px"><tbody>
<tr style="mso-yfti-irow:0;mso-yfti-firstrow:yes">
  <td width="230" style="border:1px solid black;text-align:center;font-weight:bold;font-size:16px">Kod Penyebut Harga</td>
  <td width="197" style="border:1px solid black;text-align:center;font-weight:bold;font-size:16px">Kos</td>
<td width="197" style="border:1px solid black;text-align:center;font-weight:bold;font-size:16px">Tempoh</td>
 </tr>
 <tr style="mso-yfti-irow:1;height:13.15pt">
  <td style="border:1px solid black;text-align:center;font-size:16px">Petender 1/4</td>
  <td style="border:1px solid black;text-align:center;font-size:16px">RM150,377.47</td>
  <td style="border:1px solid black;text-align:center;font-size:16px">12 BULAN</td>
 </tr>
<tr style="mso-yfti-irow:1;height:13.15pt">
  <td style="border:1px solid black;text-align:center;font-size:16px">Petender 2/4</td>
  <td style="border:1px solid black;text-align:center;font-size:16px">RM150,660.00</td>
  <td style="border:1px solid black;text-align:center;font-size:16px">12 BULAN</td>
 </tr></tbody></table>

<h3>KEPUTUSAN</h3>

<h3 style="border:none">MAKLUMAT PEMBEKAL YANG BERJAYA</h3>

<table border="1" style="border:1px solid black" width="100%">
<tbody>
<tr>
<td style="padding:10px;font-weight:bold">Nama Pembekal</td>
<td style="padding:10px;font-weight:bold"><p class="MsoNormal" align="center" style="text-align:center;line-height:16.0pt;
mso-line-height-rule:exactly">UMPSA SERVICES SDN BHD</p></td>
<td style="padding:10px;font-weight:bold">Harga Tawaran</td>
<td style="padding:10px;font-weight:bold"><b><span lang="EN-US" style="font-size:11.0pt;
line-height:115%;font-family:" arial",sans-serif;mso-fareast-font-family:calibri;="" mso-fareast-theme-font:minor-latin;mso-ansi-language:en-us;mso-fareast-language:="" en-us;mso-bidi-language:ar-sa"="">RM132,192.00</span></b><br></td>
</tr>
<tr>
<td style="padding:10px;font-weight:bold">Tarikh Mula Kontrak</td>
<td style="padding:10px;font-weight:bold">-</td>
<td style="padding:10px;font-weight:bold">Tarikh Tamat Kontrak</td>
<td style="padding:10px;font-weight:bold">-</td>
</tr></tbody></table>`;

// Real winner block from span.gov.my/tender/view/100 (captured 2026-07-11) — a different
// layout where name/price are separated from their label by a ":" cell.
const COLON_SEPARATED_CELLS = `<table class="table table-bordered" style="width: 748px; margin-bottom: 1rem; border-color: rgb(238, 238, 238); line-height: 19px;"><tbody><tr style="border: 1px solid rgb(238, 238, 238);"><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">MAKLUMAT PEMBEKAL YANG BERJAYA</td></tr></tbody></table><table class="table table-bordered" style="width: 748px; margin-bottom: 1rem; border-color: rgb(238, 238, 238); line-height: 19px;"><tbody><tr style="border: 1px solid rgb(238, 238, 238);"><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">Nama Pembekal</td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;"><div align="center">:</div></td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;"><p style="margin-bottom: 15px;">RANHILL CONSULTING SDN BHD</p></td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">Harga Tawaran</td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;"><div align="center">:</div></td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">RM1,285,996.03</td></tr><tr style="border: 1px solid rgb(238, 238, 238);"><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">Tarikh Mula Kontrak</td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;"><div align="center">:</div></td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">TBI</td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">Tarikh Tamat Kontrak</td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;"><div align="center">:</div></td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">TBI</td></tr></tbody></table>`;

// Real winner block from span.gov.my/tender/view/5 (captured 2026-07-11) — the "Nama
// Pembekal" value is the placeholder "SEBUTHARGA DITANGGUHKAN" (quotation postponed),
// not a company name, and there is no "Harga Tawaran" cell anywhere in the row.
const POSTPONED_PLACEHOLDER = `<table border="0" width="100%" style="border: 1px solid rgb(238, 238, 238); max-width: 100%;"><tbody><tr style="border: 1px solid rgb(238, 238, 238);"><td>MAKLUMAT PEMBEKAL YANG BERJAYA</td></tr></tbody></table><table class="table table-bordered" style="width: 1110px; margin-bottom: 1rem; border-color: rgb(238, 238, 238); line-height: 19px;"><tbody><tr style="border: 1px solid rgb(238, 238, 238);"><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 16px;">Nama Pembekal</td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 16px;"><div align="center">:</div></td><td colspan="4" rowspan="2" style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 16px;"><p style="margin-bottom: 15px;">SEBUTHARGA DITANGGUHKAN</p></td></tr><tr style="border: 1px solid rgb(238, 238, 238);"><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 16px;">Tarikh Mula Kontrak</td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 16px;"><div align="center">:</div></td></tr></tbody></table>`;

// Real content from span.gov.my/tender/view/40 (captured 2026-07-11) — a cancelled
// tender with no table at all, just a plain-text notice.
const CANCELLED_NO_TABLE = `<p>Dibatalkan <br>*Sebutharga terbatal dan akan dilakukan semula<br></p>`;

describe('parseSpanDetailWinners', () => {
  it('extracts a winner from adjacent name/price cells, ignoring the all-bidders cost table', () => {
    expect(parseSpanDetailWinners(ADJACENT_CELLS_WITH_BIDDER_TABLE)).toEqual([
      { name: 'UMPSA SERVICES SDN BHD', price: 132192 },
    ]);
  });

  it('extracts a winner when name/price cells are separated by a ":" cell', () => {
    expect(parseSpanDetailWinners(COLON_SEPARATED_CELLS)).toEqual([
      { name: 'RANHILL CONSULTING SDN BHD', price: 1285996.03 },
    ]);
  });

  it('returns no winners for a postponed placeholder with no Harga Tawaran cell', () => {
    expect(parseSpanDetailWinners(POSTPONED_PLACEHOLDER)).toEqual([]);
  });

  it('returns no winners for a cancelled tender with no table at all', () => {
    expect(parseSpanDetailWinners(CANCELLED_NO_TABLE)).toEqual([]);
  });

  it('returns no winners for empty or unrelated html, without throwing', () => {
    expect(parseSpanDetailWinners('')).toEqual([]);
    expect(parseSpanDetailWinners('<p>not a tender page</p>')).toEqual([]);
  });

  it('parses multiple winners when multiple matching rows are present (multi-lot award)', () => {
    const multiLot = `<table><tbody>
<tr><td>Nama Pembekal</td><td>ALPHA ENGINEERING SDN BHD</td><td>Harga Tawaran</td><td>RM50,000.00</td></tr>
</tbody></table>
<table><tbody>
<tr><td>Nama Pembekal</td><td>BETA CONSTRUCTION SDN BHD</td><td>Harga Tawaran</td><td>RM75,500.50</td></tr>
</tbody></table>`;
    expect(parseSpanDetailWinners(multiLot)).toEqual([
      { name: 'ALPHA ENGINEERING SDN BHD', price: 50000 },
      { name: 'BETA CONSTRUCTION SDN BHD', price: 75500.5 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w backend -- spanParseDetail`
Expected: FAIL — `Cannot find module '../src/scrapers/span/parseDetail.js'` (the file doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `backend/src/scrapers/span/parseDetail.ts`:

```ts
import * as cheerio from 'cheerio';
import type { AnyNode, Cheerio } from 'cheerio';
import type { Winner } from '@tms/shared';
import { parseRmPrice } from '../../parsing/text.js';

const NAME_LABEL = 'Nama Pembekal';
const PRICE_LABEL = 'Harga Tawaran';

export function parseSpanDetailWinners(html: string): Winner[] {
  const $ = cheerio.load(html);
  const winners: Winner[] = [];

  $('tr').each((_, rowEl) => {
    const cells = $(rowEl).find('td');
    const nameIdx = findCellIndex($, cells, NAME_LABEL);
    const priceIdx = findCellIndex($, cells, PRICE_LABEL);
    if (nameIdx === -1 || priceIdx === -1) return;

    const name = valueAfter($, cells, nameIdx);
    const price = parseRmPrice(valueAfter($, cells, priceIdx));
    if (!name || price === null) return;

    winners.push({ name, price });
  });

  return winners;
}

function findCellIndex($: cheerio.CheerioAPI, cells: Cheerio<AnyNode>, label: string): number {
  for (let i = 0; i < cells.length; i += 1) {
    if (clean($(cells[i]).text()) === label) return i;
  }
  return -1;
}

function valueAfter($: cheerio.CheerioAPI, cells: Cheerio<AnyNode>, labelIdx: number): string {
  for (let i = labelIdx + 1; i < cells.length; i += 1) {
    const text = clean($(cells[i]).text());
    if (text === '' || text === ':') continue;
    return text;
  }
  return '';
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w backend -- spanParseDetail`
Expected: PASS — 6 tests passing in `spanParseDetail.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrapers/span/parseDetail.ts backend/test/spanParseDetail.test.ts
git commit -m "$(cat <<'EOF'
feat(backend): parse winner name/price from SPAN tender detail pages

Handles the two real layout variants observed (adjacent cells vs a
":" separator cell), and guards against placeholder text like
"SEBUTHARGA DITANGGUHKAN" by only accepting a row that has both a
name and a parseable RM price.
EOF
)"
```

---

### Task 2: Wire detail-page fetching into `SpanAdapter`

**Files:**
- Modify: `backend/src/scrapers/span/adapter.ts`
- Modify: `backend/test/spanAdapter.test.ts`

**Interfaces:**
- Consumes: `parseSpanDetailWinners(html: string): Winner[]` from Task 1 (`./parseDetail.js`); existing `TenderPatch` shape (each patch from `parseSpanListingHtml` already has `status`, `source: { sourceId, sourceUrl }`, and every other required `TenderPatchSchema` field); existing `this.fetcher: (url: string) => Promise<unknown>` (already rate-limited via `createPoliteFetcher` in `backend/src/index.ts` — no changes there).
- Produces: no new exports. `SpanAdapter.scrape()`'s existing `onBatch`/`onProgress`/`onJobDone`/`isCancelled` contract (from `backend/src/scrapers/types.ts`) is reused, not changed.

- [ ] **Step 1: Write the failing tests**

Add to the bottom of `backend/test/spanAdapter.test.ts`, inside the existing `describe('SpanAdapter — job model', ...)` block (before its closing `});`) — reuses the file's existing `FIXED_NOW` and `pageHtml` helpers:

```ts
  // Real winner block from span.gov.my/tender/view/147 (captured 2026-07-11), simplified
  // to a single row — Task 1's parser tests already cover layout variants exhaustively,
  // so these adapter tests only need to prove the wiring, not the parsing.
  const WINNER_DETAIL_HTML = `<table><tbody>
<tr><td>Nama Pembekal</td><td>UMPSA SERVICES SDN BHD</td><td>Harga Tawaran</td><td>RM132,192.00</td></tr>
</tbody></table>`;

  it('fetches the detail page for each closed tender and merges winners into a follow-up batch', async () => {
    const listingHtml = pageHtml(1, 'REF/OPEN', 'Diiklankan') + pageHtml(2, 'REF/CLOSED', 'Selesai');
    const fetcher = vi.fn(async (url: string) => {
      if (url === 'https://www.span.gov.my/tender/2026') return listingHtml;
      if (url === 'https://www.span.gov.my/tender/view/2') return WINNER_DETAIL_HTML;
      throw new Error(`unexpected url: ${url}`);
    });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    const batches: TenderPatch[][] = [];
    await adapter.scrape('open', { onProgress: () => {}, onBatch: async (t) => { batches.push(t); } });

    expect(fetcher).toHaveBeenCalledWith('https://www.span.gov.my/tender/view/2');
    expect(fetcher).not.toHaveBeenCalledWith('https://www.span.gov.my/tender/view/1');
    const detailBatch = batches.find((b) => b[0]?.winners !== undefined);
    expect(detailBatch).toBeDefined();
    expect(detailBatch![0]!.source.sourceId).toBe('2');
    expect(detailBatch![0]!.winners).toEqual([{ name: 'UMPSA SERVICES SDN BHD', price: 132192 }]);
  });

  it('records winners: null when a closed tender detail page has no winner yet', async () => {
    const listingHtml = pageHtml(2, 'REF/CLOSED', 'Selesai');
    const fetcher = vi.fn(async (url: string) => {
      if (url === 'https://www.span.gov.my/tender/2026') return listingHtml;
      return '<p>Dibatalkan</p>';
    });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    const batches: TenderPatch[][] = [];
    await adapter.scrape('open', { onProgress: () => {}, onBatch: async (t) => { batches.push(t); } });

    const detailBatch = batches.find((b) => b[0]?.winners !== undefined);
    expect(detailBatch).toBeDefined();
    expect(detailBatch![0]!.winners).toBeNull();
  });

  it('skips a tender whose detail fetch fails, without aborting the job', async () => {
    const listingHtml = pageHtml(2, 'REF/A', 'Selesai') + pageHtml(3, 'REF/B', 'Selesai');
    const fetcher = vi.fn(async (url: string) => {
      if (url === 'https://www.span.gov.my/tender/2026') return listingHtml;
      if (url === 'https://www.span.gov.my/tender/view/2') throw new Error('timeout');
      if (url === 'https://www.span.gov.my/tender/view/3') return WINNER_DETAIL_HTML;
      throw new Error(`unexpected url: ${url}`);
    });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    const done: string[] = [];
    const batches: TenderPatch[][] = [];
    await adapter.scrape('open', {
      onProgress: () => {},
      onBatch: async (t) => { batches.push(t); },
      onJobDone: (name) => done.push(name),
    });

    expect(done).toEqual(['open-2026']);
    const winnerBatches = batches.filter((b) => b[0]?.winners !== undefined);
    expect(winnerBatches).toHaveLength(1);
    expect(winnerBatches[0]![0]!.source.sourceId).toBe('3');
  });

  it('stops the detail-fetch loop when isCancelled reports true partway through', async () => {
    const listingHtml = pageHtml(2, 'REF/A', 'Selesai') + pageHtml(3, 'REF/B', 'Selesai');
    const fetcher = vi.fn(async (url: string) => {
      if (url === 'https://www.span.gov.my/tender/2026') return listingHtml;
      return WINNER_DETAIL_HTML;
    });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    let cancel = false;
    const batches: TenderPatch[][] = [];
    await adapter.scrape('open', {
      onProgress: () => {},
      onBatch: async (t) => { batches.push(t); if (t[0]!.winners !== undefined) cancel = true; },
    }, { isCancelled: () => cancel });

    expect(batches).toHaveLength(2); // listing batch + exactly one detail batch
    expect(fetcher).toHaveBeenCalledTimes(2); // listing fetch + first detail fetch only
  });

  it('reports detail-fetch progress as currentPage/lastPage over the closed tenders in the job', async () => {
    const listingHtml = pageHtml(2, 'REF/A', 'Selesai') + pageHtml(3, 'REF/B', 'Selesai');
    const fetcher = vi.fn(async (url: string) => {
      if (url === 'https://www.span.gov.my/tender/2026') return listingHtml;
      return WINNER_DETAIL_HTML;
    });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    const progress: unknown[] = [];
    await adapter.scrape('open', { onProgress: (p) => progress.push({ ...p }), onBatch: async () => {} });

    expect(progress).toContainEqual({
      source: 'span', job: 'open-2026', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 2,
    });
    expect(progress).toContainEqual({
      source: 'span', job: 'open-2026', jobsCompleted: 0, jobsTotal: 1, currentPage: 2, lastPage: 2,
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w backend -- spanAdapter`
Expected: FAIL — the new assertions fail because no detail fetch happens yet (e.g. `expect(fetcher).toHaveBeenCalledWith('https://www.span.gov.my/tender/view/2')` fails since `fetcher` was only called once, for the listing page).

- [ ] **Step 3: Write the minimal implementation**

In `backend/src/scrapers/span/adapter.ts`, add imports:

```ts
import { z } from 'zod';
import type { ScrapeHooks, ScrapeOptions, ScrapeScope, ScraperAdapter } from '../types.js';
import { parseSpanListingHtml } from './parseListing.js';
import { parseSpanDetailWinners } from './parseDetail.js';
import type { Winner } from '@tms/shared';
```

Replace the body of `scrape()` (from `const patches = parseSpanListingHtml(html);` through the closing of the `for` loop) with:

```ts
      const patches = parseSpanListingHtml(html);
      await hooks.onBatch(patches);

      const closedPatches = patches.filter((p) => p.status === 'closed');
      for (const [detailIndex, patch] of closedPatches.entries()) {
        if (opts.isCancelled?.()) return;
        hooks.onProgress({
          source: this.name,
          job: name,
          jobsCompleted: jobIndex,
          jobsTotal: jobs.length,
          currentPage: detailIndex + 1,
          lastPage: closedPatches.length,
        });
        let winners: Winner[];
        try {
          const detailHtml = HtmlResponse.parse(await this.fetcher(patch.source.sourceUrl));
          winners = parseSpanDetailWinners(detailHtml);
        } catch (err) {
          console.warn(`[span] skipping detail fetch for ${patch.source.sourceUrl}: ${err}`);
          continue;
        }
        await hooks.onBatch([{ ...patch, winners: winners.length > 0 ? winners : null }]);
      }

      await hooks.onJobDone?.(name);
    }
  }
}
```

The full file should now read:

```ts
import { z } from 'zod';
import type { ScrapeHooks, ScrapeOptions, ScrapeScope, ScraperAdapter } from '../types.js';
import { parseSpanListingHtml } from './parseListing.js';
import { parseSpanDetailWinners } from './parseDetail.js';
import type { Winner } from '@tms/shared';

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
      if (opts.isCancelled?.()) return;
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

      const closedPatches = patches.filter((p) => p.status === 'closed');
      for (const [detailIndex, patch] of closedPatches.entries()) {
        if (opts.isCancelled?.()) return;
        hooks.onProgress({
          source: this.name,
          job: name,
          jobsCompleted: jobIndex,
          jobsTotal: jobs.length,
          currentPage: detailIndex + 1,
          lastPage: closedPatches.length,
        });
        let winners: Winner[];
        try {
          const detailHtml = HtmlResponse.parse(await this.fetcher(patch.source.sourceUrl));
          winners = parseSpanDetailWinners(detailHtml);
        } catch (err) {
          console.warn(`[span] skipping detail fetch for ${patch.source.sourceUrl}: ${err}`);
          continue;
        }
        await hooks.onBatch([{ ...patch, winners: winners.length > 0 ? winners : null }]);
      }

      await hooks.onJobDone?.(name);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w backend -- spanAdapter`
Expected: PASS — all tests in `spanAdapter.test.ts` (the pre-existing ones plus the 5 new ones) passing.

- [ ] **Step 5: Run the full backend suite**

Run: `npm test -w backend`
Expected: PASS — no regressions in `spanParseListing.test.ts`, `adapter.test.ts` (MyProcurement), `repository.test.ts`, `manager.test.ts`, etc. (none of those files reference SPAN's detail-fetch behavior, so they should be unaffected).

- [ ] **Step 6: Commit**

```bash
git add backend/src/scrapers/span/adapter.ts backend/test/spanAdapter.test.ts
git commit -m "$(cat <<'EOF'
feat(backend): fetch SPAN closed-tender detail pages for winner data

Only closed tenders trigger a detail fetch (open ones can't have a
winner yet). One tender's fetch failure is logged and skipped rather
than aborting the whole year's job. Reuses the existing rate-limited
fetcher and onBatch/onProgress contract — no new infrastructure.
EOF
)"
```

---

## Out of scope (unchanged from the design doc)

- The timeline/venue (`events`) section of the detail page.
- The "all bidders" cost table (every bidder's price, not just the winner's).
- Per-tender retry of permanently-failed detail fetches within an already-completed archive job.
- Detail-page enrichment for MyProcurement or KWSP.
