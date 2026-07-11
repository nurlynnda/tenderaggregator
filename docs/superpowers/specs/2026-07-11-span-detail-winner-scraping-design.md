# SPAN Detail-Page Winner Scraping — Design

**Date:** 2026-07-11
**Status:** Approved by user

## Purpose

The original SPAN adapter ([2026-07-09-span-tender-source-design.md](2026-07-09-span-tender-source-design.md))
deliberately scraped listing pages only, deferring detail-page enrichment because the
detail page (`/tender/view/:id`) is unstructured, Word-pasted HTML. This iteration
implements that deferred work for one specific field: who won a closed tender and what
price they won it for (`winners: [{ name, price }]`), matching the shape MyProcurement
already populates from its own results pages.

## Site structure (verified 2026-07-11, five real detail pages fetched)

The winner block is not a fixed template — it's manually pasted per-tender content, so
layout varies:

- **Adjacent cells** (`/tender/view/147`): one `<tr>` with 4 `<td>`s —
  `Nama Pembekal`, `UMPSA SERVICES SDN BHD`, `Harga Tawaran`, `RM132,192.00`.
- **Colon-separated cells** (`/tender/view/100`): one `<tr>` with 6 `<td>`s —
  `Nama Pembekal`, `:`, `RANHILL CONSULTING SDN BHD`, `Harga Tawaran`, `:`,
  `RM1,285,996.03`.
- **Postponed placeholder** (`/tender/view/5`): a `Nama Pembekal` cell whose value is the
  literal text `SEBUTHARGA DITANGGUHKAN` ("quotation postponed") — not a company name —
  with no `Harga Tawaran` cell anywhere in that row.
- **No result published** (`/tender/view/40`): tender cancelled (`Dibatalkan`), no table
  at all, just a plain-text notice.
- A separate "all bidders" cost table (`Petender 1/4`, `Petender 2/4`, ...) also appears
  on pages with results. This lists every bidder's price, not just the winner's — it is
  **not** the `winners` field and is not parsed by this work.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Which tenders get a detail fetch | Only tenders whose listing patch has `status: 'closed'`. Open tenders can't have a winner yet — fetching their detail pages would double request volume for no data. |
| Scope of detail-page data captured | Winners only. The page also has a timeline/venue section that could map to the `events` field, but that's explicitly out of scope for this iteration — nothing in the UI surfaces `events` yet. |
| Placeholder/no-result guard | A row only produces a winner when it has **both** a non-empty `Nama Pembekal` name **and** a `Harga Tawaran` value that parses as a real `RM` amount, in the same `<tr>`. This is what rejects `SEBUTHARGA DITANGGUHKAN` — that row has no `Harga Tawaran` cell at all, so it's excluded by construction, with no hand-maintained blocklist of placeholder phrases needed. |
| Detail-fetch failure for one tender | Logged and skipped; the rest of that job's tenders (and the job itself) still complete normally. One broken/timed-out detail page must not block an entire year's worth of listing data from being saved. |
| Multi-winner tenders | Parser collects every matching `<tr>` on the page, not just the first — supports multi-lot awards without special-casing, consistent with how MyProcurement's results parser already handles multiple winner rows. |

## New parser: `backend/src/scrapers/span/parseDetail.ts`

`parseSpanDetailWinners(html: string): Winner[]`

Algorithm:

1. Load the page with cheerio, iterate every `<tr>`.
2. Within a row, look for a cell whose cleaned text is exactly `Nama Pembekal` and a cell
   whose cleaned text is exactly `Harga Tawaran`. Skip the row if either is missing.
3. For each label cell, find its value: walk forward through sibling `<td>`s, skipping any
   cell whose cleaned text is exactly `:`, and take the first remaining cell's text.
4. Parse the price value with the existing `parseRmPrice` helper
   (`backend/src/parsing/text.ts`, already used by MyProcurement's results parser — same
   `RM 1,234.56` format, requires a literal `RM` prefix to return non-null).
5. Push `{ name, price }` only if the name is non-empty and the price parsed successfully.
6. Return the collected list (possibly empty).

No new dependencies; reuses `parseRmPrice` and the existing cheerio usage pattern already
established in `parseListing.ts` and MyProcurement's `parseResults.ts`.

## Adapter integration (`backend/src/scrapers/span/adapter.ts`)

After a job's listing page is fetched and parsed (unchanged from today) and the initial
`onBatch(patches)` call is made (unchanged — this is what keeps today's behavior and
tests for the listing-only path intact), add a second pass over that job's closed
patches:

```
const closed = patches.filter(p => p.status === 'closed');
for (const [i, patch] of closed.entries()) {
  if (opts.isCancelled?.()) return;
  hooks.onProgress({ source: this.name, job: name, jobsCompleted: jobIndex, jobsTotal: jobs.length,
                      currentPage: i + 1, lastPage: closed.length });
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
```

Notes:

- Reuses `this.fetcher` (the same rate-limited `politeFetch` instance already wired up in
  `backend/src/index.ts`, with its own delay/jitter/backoff/`Retry-After` handling) — no
  new rate-limiting code.
- Reuses `patch.scrapedAt` unchanged (no new clock plumbing needed): since no prior patch
  for this source has ever written a `winners` key, there's no stale-write risk from
  `repository.ts`'s provenance check (`prov['winners']` is `undefined` the first time).
- `winners: null` (as opposed to omitting the key) is written when the detail page yields
  no winners — this is a real observation ("checked, none found"), not "field not
  scraped by this source." `winners` is already in `repository.ts`'s `NULLABLE_FIELDS`
  set, so this can never clobber a winner a *different* patch already established for the
  same tender.
- Progress reporting repurposes `currentPage`/`lastPage` (already shown in the UI as
  "Fetching {job} — page X / Y") to mean "detail page X of Y closed tenders" during this
  second pass, rather than listing pagination. No shared-type or frontend changes needed.
- `isCancelled` is checked before each detail fetch, not just once per job, so cancelling
  a long-running archive backfill takes effect promptly instead of only between years.
- Resumability stays job-level (whole year), matching the existing archive-backfill
  model: if one tender's detail fetch fails, the year still completes and is marked done
  in `completedArchiveJobs` — that one tender's `winners` stays `null` until a future
  full rescrape of that job (open jobs get rescraped on demand; a permanently-failed
  archive-year tender would need a manual full rescrape to retry). No per-tender retry
  queue is being built for this iteration.

## Wiring

No new files beyond `parseDetail.ts`. No changes to `backend/src/index.ts` (same adapter
construction as today), `shared/src/tender.ts` (schema already supports `winners`), or
`backend/src/storage/repository.ts` (`winners` is already in `NULLABLE_FIELDS`).

## Testing / TDD

- `backend/test/spanParseDetail.test.ts`:
  - Adjacent-cells layout (`/tender/view/147`-style) → correct `{ name, price }`.
  - Colon-separated layout (`/tender/view/100`-style) → correct `{ name, price }`.
  - Postponed placeholder (`/tender/view/5`-style: `Nama Pembekal` present, no `Harga
    Tawaran` in the row) → empty array, not a fake winner.
  - Cancelled tender with no table at all (`/tender/view/40`-style) → empty array.
  - Synthesized multi-winner HTML (two independent matching rows) → both winners
    returned, in document order.
  - Empty/garbage HTML → empty array, no throw.
- Trimmed real HTML captured from the pages fetched during this design pass become test
  fixtures, following the existing `span-2026.html` convention.
- `backend/test/spanAdapter.test.ts` additions:
  - A closed tender in the listing triggers a detail fetch to its `sourceUrl`; an open
    tender does not.
  - The resulting `onBatch` call for a closed tender carries `winners` merged onto that
    tender's identity fields.
  - One tender's detail-fetch failure is logged and skipped; sibling tenders in the same
    job still get processed, and `onJobDone` still fires for the job.
  - `isCancelled` returning true mid-detail-loop stops further detail fetches without
    throwing.
  - Progress reporting during the detail loop uses `currentPage`/`lastPage` as index/count
    of closed tenders processed so far.

## Out of scope (this iteration)

- The timeline/venue (`events`) section of the detail page.
- The "all bidders" cost table (every bidder's price, not just the winner's).
- Per-tender retry of permanently-failed detail fetches within an already-completed
  archive job.
- Detail-page enrichment for MyProcurement or KWSP (unaffected by this change).
