# KWSP Tender Data Source — Design

**Date:** 2026-07-11
**Status:** Approved by user

## Purpose

Add a third tender data source: KWSP (Kumpulan Wang Simpanan Pekerja / Employees
Provident Fund), [kwsp.gov.my/en/corporate/procurement/tenders](https://www.kwsp.gov.my/en/corporate/procurement/tenders).
Like SPAN, KWSP exposes no JSON API — it's a single server-rendered HTML page (a Liferay
CMS page) meant for browsers. This adapter must fit the existing `ScraperAdapter`
interface and standardized `Tender` schema, and — per the user's core requirement — must
never let a KWSP patch overwrite a field another source (or an earlier KWSP scrape)
already knows, only add to it.

## Site structure (verified 2026-07-11)

- `GET https://www.kwsp.gov.my/en/corporate/procurement/tenders` returns the **entire**
  page in one response: no pagination, no separate archive URL. Confirmed reachable with
  a plain `curl` request using both a browser user-agent and the project's actual bot
  user-agent (`TenderAggregatorBot/1.0`) — no Cloudflare JS challenge on this path (only
  `/robots.txt` showed a challenge once, and the tenders page itself doesn't need
  `robots.txt`). No special TLS/cert workaround needed (unlike SPAN).
- The page has two independent sections:

  **1. "New Tenders Out"** — currently open tenders, one `div.card-bg` block each:
  ```html
  <div class="card-bg">
    <h4>...</h4>            <!-- empty placeholder -->
    <h4>...</h4>            <!-- empty placeholder -->
    <h4>Cadangan Kerja-Kerja Penggantian Sistem Pam...</h4>   <!-- title, only non-empty h4 -->
    ...
    <h4><span class="lead">Tender No.</span></h4>
    <ul><li><p>Doc5759801507</p></li></ul>
    ...
    <h4><span class="lead">Qualification Criteria</span></h4>
    <div>CIDB Gred G4, M02/M15/M20/M22 and SPKK</div>
    <h4><span class="lead">Open Date</span></h4>
    <ul><li>06.07.2026 (Monday)</li></ul>
    <h4><span class="lead">Closing Date</span></h4>
    <ul><li><p>03.08.2026 (Monday)</p></li></ul>
    <h4><span class="lead">Document Price</span></h4>
    <ul><li>Free</li></ul>
    ...
    <a href="https://forms.office.com/...">Apply For Tender</a>
    <a href="/documents/d/guest/c-3277-kwsp-na-artwork-1">More Info</a>
  </div>
  ```
  - Title: within the card, the (single) `h4.component-heading` with non-empty text —
    the first two are always-empty placeholders left blank by KWSP's editors.
  - Tender No.: text following the "Tender No." label — this is the reference number
    (e.g. `Doc5759801507`) and, critically, uses the **same numbering scheme** as the
    Tender Results section below.
  - Open Date / Closing Date: `dd.mm.yyyy (Weekday)` format (the weekday and the space
    before it are decoration, dropped).
  - "More Info" link → `sourceUrl` (resolved to an absolute URL; page is same-origin so a
    relative `/documents/...` href becomes `https://www.kwsp.gov.my/documents/...`).
    "Apply For Tender" links to an external MS Forms URL and isn't part of tender
    identity — ignored.
  - No status badge — every card in this section is implicitly open.
  - No structural signal for quotation vs. tender vs. requisition (unlike SPAN's title
    keywords) — this page is specifically KWSP's *Tenders* listing, so `procurementType`
    is fixed to `'tender'`.

  **2. "Tender Results"** — one `div.accordion-card` per year (2026, 2025, 2023 seen),
  each containing one `div.accordion-item` per month:
  ```html
  <div class="accordion-item">
    <div class="accordion-header"><h3>December 2025</h3>...</div>
    <div class="accordion-content">
      <p>Penerbitan Laporan Tahunan Bersepadu...<br>
         <em>Doc5343777870<br> Nova Fusion Sdn Bhd</em></p>
      <hr>
      <p>Perkhidmatan Penghantaran Khidmat Pesanan Ringkas...<br>
         <em>Doc5248683420<br> Maxis Broadband Sdn Bhd<br> Celcom Berhad</em></p>
      <hr>
      ...
    </div>
  </div>
  ```
  - Each `<p>` (direct child of `.accordion-content`) is one awarded tender: title before
    the first `<br>`, then an `<em>` block with the tender number (`Doc...`) on its own
    line followed by one or more winner names (some tenders have multiple winners, e.g.
    joint awards). No price is ever published.
  - Only a month + year is known (e.g. "December 2025") — no exact day.
  - No per-entry link exists in this section.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Job model | One HTTP fetch per `scrape()` call, split into two jobs after parsing: `open` (New Tenders Out — rescraped every run) and `results` (Tender Results — backfilled once, then skipped, matching the project's "archive backfill = once, resumable" rule). Fetching once and splitting avoids a redundant second request for data already in hand. |
| Missing exact date on results entries | Approximate `closingDate` to the 1st of the published month (e.g. "March 2026" → `2026-03-01`); `advertisedDate` left unset since it's not implied at all. User confirmed this trade-off (approximate date beats no date) after being shown the alternative (leave both null). |
| `procurementType` | Fixed `'tender'` for every KWSP record — this page is specifically KWSP's Tenders section, no quotation/requisition signal exists to infer from. |
| Results entries' `sourceUrl` | No per-entry link exists in this section; falls back to the tenders page URL itself. Schema requires a valid URL per record, and the page URL is still a truthful "this is where we found it" pointer. |
| Cross-section identity | Both sections reuse the same `Doc...` numbering as the tender's reference number. This means a tender that starts in "New Tenders Out" and later gets awarded (moves to "Tender Results") merges into the *same* stored record via `dedupKey` instead of creating a duplicate — the results patch fills in `winners`/`status: closed` while the earlier open patch's `advertisedDate` is preserved untouched (results patches omit fields they don't observe, never send them as `null`/`[]`). |

## Field mapping (`backend/src/scrapers/kwsp/parseListing.ts`)

| Tender field | Open tenders section | Results section |
|---|---|---|
| `referenceNo` | "Tender No." text | tender number from `<em>` first line |
| `title` | non-empty `h4.component-heading` in card | text before first `<br>` in `<p>` |
| `status` | `'open'` | `'closed'` |
| `procurementType` | `'tender'` (fixed) | `'tender'` (fixed) |
| `agency` | `"Kumpulan Wang Simpanan Pekerja (KWSP)"` (fixed) | same |
| `advertisedDate` | "Open Date", `dd.mm.yyyy` parsed, weekday suffix dropped | omitted (unknown) |
| `closingDate` | "Closing Date", same parser | 1st of the published month, e.g. `2026-03-01` |
| `winners` | omitted | one entry per name after the tender number line, `price: null` |
| `sourceId` | slug/path segment of the "More Info" href (e.g. `c-3277-kwsp-na-artwork-1`) | tender number (no per-entry link to derive an id from) |
| `sourceUrl` | "More Info" href resolved to an absolute URL via `new URL(href, BASE_URL)` | tenders page URL itself (no per-entry link) |
| `raw` | Tender No., title, Qualification Criteria, Open Date, Closing Date, Document Price (verbatim text) | title, tender number, winner name(s), month label (verbatim text) |
| `dedupKey` | `computeDedupKey(referenceNo, fallback)`, `fallback = `kwsp:${sourceId}`` | same helper, same fallback shape |
| `source` | `{ source: 'kwsp', sourceId, sourceUrl }` | same |

`ministry`, `category`, `fieldCodes`, `indicativePrice`, `events` are omitted from every
KWSP patch (never structurally available) — omitted, not `null`/`[]`, so they never erase
a value another source may already have contributed for the same `dedupKey`.

A card or result entry missing a parseable title or tender number is skipped and logged,
matching the SPAN/MyProcurement parsers' existing behavior.

## Job model detail (`backend/src/scrapers/kwsp/adapter.ts`)

- `scrape()` fetches the page once if either job is in scope; parses both sections
  regardless, then emits progress/batch/`onJobDone` only for the job(s) actually in scope
  (so `scope: 'open'` never reports progress for `results`, and vice versa).
- Job names: `'open'`, `'results'`.
- `archiveJobNames()` → `['results']`.
- `results` job is skipped on a run if `opts.skipJobNames` already contains `'results'`
  (same convention as SPAN's per-year closed jobs) — matches "backfilled once".

## Fetching & rate limiting

Reuses `createPoliteFetcher({ responseType: 'text' })` unmodified — no new fetch
infrastructure needed (confirmed no TLS/Cloudflare workaround required, unlike SPAN).

## Wiring

- New files: `backend/src/scrapers/kwsp/adapter.ts`, `backend/src/scrapers/kwsp/parseListing.ts`.
- `backend/src/index.ts`: register `new KwspAdapter(createPoliteFetcher({ responseType: 'text' }))`
  alongside the existing `MyProcurementAdapter` and `SpanAdapter`.
- No repository changes needed — the existing `mergeOne()` upsert-by-`dedupKey` logic
  (last-write-wins per field, `NULLABLE_FIELDS` guard, omitted keys are no-ops) already
  gives KWSP the same "not overwritten, only upserted" guarantee the other two sources
  have, including cross-source merges if a KWSP tender ever shares a normalized reference
  number with another source (unlikely given KWSP's internal `Doc...` numbering, but
  handled automatically regardless).

## Testing / TDD

- `backend/test/fixtures/kwsp-tenders.html`: trimmed real fixture covering both sections —
  at least one open card, one results month with a single-winner entry, one results month
  with a multi-winner entry, and one malformed/unparseable block to exercise the
  skip-and-log path.
- Parser unit tests: title extraction (skipping empty placeholder `h4`s), tender number
  extraction, `dd.mm.yyyy (Weekday)` date parsing (including the weekday/whitespace
  stripping), month-label → `closingDate` approximation, multi-winner splitting,
  relative-to-absolute URL resolution for "More Info" links, skip-on-unparseable-block.
- Adapter tests (mirroring `spanAdapter.test.ts`): single fetch per `scrape()` call
  regardless of how many jobs are in scope; `scope='open'` only reports/emits the `open`
  job; `scope='archive'` only the `results` job; `scope='all'` both; `archiveJobNames()`;
  `skipJobNames` skips `results` when already backfilled; `isCancelled` respected between
  jobs.
- Repository test: merge an `open`-job KWSP patch followed by a `results`-job KWSP patch
  sharing the same `dedupKey` (simulating a tender getting awarded), asserting the
  `advertisedDate`/`Qualification Criteria` from the first patch survive untouched while
  `status`/`winners`/`closingDate` update from the second. This is the concrete test for
  the "not overwritten, only upserted" requirement as it applies to this source.

## Out of scope (this iteration)

- Scraping KWSP's per-tender document pages (the "More Info" / `/documents/d/guest/...`
  links) — same "listing data only, detail scraped on demand later" deferral as the other
  two sources.
- `category`, `fieldCodes`, `indicativePrice`, `events` for KWSP records — not available
  from this page.
- Any other new data sources.
