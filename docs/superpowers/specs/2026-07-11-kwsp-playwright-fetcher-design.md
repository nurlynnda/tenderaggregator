# KWSP Playwright-Based Fetcher — Design

**Date:** 2026-07-11
**Status:** Approved by user

## Purpose

KWSP's tender page (`https://www.kwsp.gov.my/en/corporate/procurement/tenders`) is now
served behind Cloudflare's bot-mitigation layer. A plain HTTP request (what the KWSP
adapter currently uses, via `createPoliteFetcher`) is served a JavaScript challenge page
("Just a moment...", HTTP 403, `cf-mitigated: challenge`) instead of the real tender
listing — confirmed reproducible on every attempt, regardless of headers sent. The KWSP
data store has zero tenders and no `meta.json`, meaning this source has never
successfully completed a scrape in this environment; this is pre-existing, not caused by
any other recent change.

A throwaway Playwright test against the real page (2026-07-11) confirmed a real headless
Chrome browser passes this challenge cleanly on the first request — no stealth plugins or
extra evasion tooling needed. This design replaces KWSP's fetch mechanism with a
Playwright-driven browser, while leaving everything else about how KWSP tenders are
parsed unchanged.

## Root cause (verified 2026-07-11)

- `curl` with a bot-identifying `User-Agent` succeeds every time (HTTP 200, real
  ~316KB page).
- Node's built-in `fetch` (what `politeFetch` uses) with the same headers fails every
  time (HTTP 403, `cf-mitigated: challenge`, ~10KB "Just a moment..." page).
- The differentiator is not header content — it's that Cloudflare's JS challenge
  requires a real JavaScript engine to solve, which a plain HTTP client doesn't have and
  a real browser does.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Docker base image | Switch `backend/Dockerfile` from `node:22-alpine` to Playwright's official Docker image, pinned to match the `playwright` npm package version. Alpine (musl libc) doesn't reliably support Playwright's bundled Chromium; hand-rolling the system dependency list on a fuller distro is fragile and would need to be kept in sync with every Playwright/Chrome update. Playwright's own image is the officially tested combination. |
| Browser lifecycle | Launch a fresh headless Chrome per KWSP scrape call, close it when done. KWSP's entire scrape is a single page fetch (not paginated, not repeated per-job like SPAN's per-tender detail fetches), and scrapes happen infrequently (startup, on-demand rescrape) — a persistent background browser would hold real memory for a process that's idle almost all the time, for no latency benefit that matters here. |
| Stealth/anti-detection tooling | None added. The throwaway test passed with plain Playwright (`headless: true`, a realistic desktop Chrome `User-Agent`, no other evasion). Adding stealth-plugin complexity now would be solving a problem not currently observed. |
| Scope | Fetcher replacement only. `KwspAdapter` and `parseListing.ts` are unchanged — they already receive HTML text via an injected `(url) => Promise<unknown>` function and don't know or care how it was fetched. No new data extraction (KWSP's existing name-only "Winners" field on results stays as-is). MyProcurement and SPAN's fetchers are untouched. |

## The fetcher: `backend/src/scrapers/kwsp/kwspBrowserFetchImpl.ts`

Follows the exact pattern already established by `backend/src/scrapers/span/spanFetchImpl.ts`:
a small module wrapping a source-specific network requirement behind the same
`(url: string) => Promise<string>` shape every adapter's fetcher already uses, with its
dependencies injectable so tests never touch a real browser or the real network.

```ts
export interface KwspBrowserFetchImplDeps {
  launchChromium?: (opts: { headless: boolean }) => Promise<Browser>; // defaults to playwright's chromium.launch
  waitSelector?: string;   // defaults to 'div.card-bg' — same element parseListing.ts looks for
  navigationTimeoutMs?: number; // defaults to 20000
  maxAttempts?: number;    // defaults to 2
  userAgent?: string;      // defaults to the desktop Chrome UA string given below
}

export function createKwspBrowserFetchImpl(deps?: KwspBrowserFetchImplDeps): (url: string) => Promise<string>;
```

Default `userAgent` (the exact string used in the 2026-07-11 throwaway test that passed):

```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
```

Per call:

1. Launch a fresh headless browser (`launchChromium`, defaulting to Playwright's real
   `chromium.launch({ headless: true })`).
2. Open a new page with the configured `User-Agent` (a realistic desktop Chrome string —
   deliberately not the `TenderAggregatorBot/1.0` identifier the other sources' plain
   `fetch` calls use, since there's no reason to invite extra scrutiny on a browser
   request).
3. Navigate to the given URL.
4. Wait for `waitSelector` (`div.card-bg`) to appear, up to `navigationTimeoutMs`. This is
   a concrete signal that Cloudflare's challenge has cleared and the real tender listing
   has rendered — not a blind fixed delay, so it returns as soon as the real content is
   present instead of always waiting the maximum.
5. Read `page.content()` (the full rendered HTML) and return it.
6. Always close the page and browser in a `finally`, whether the call succeeded or threw.

**Retry:** if step 3 or 4 fails (navigation error, or the selector never appears within
the timeout — e.g. the challenge didn't clear), retry once more (`maxAttempts` default
2) with a fresh browser launch. If the second attempt also fails, throw a clear error
(e.g. `kwsp: page did not render past Cloudflare challenge after 2 attempt(s)`) — this
propagates up through `KwspAdapter.scrape()` exactly like any other fetch failure does
today (the existing `HtmlResponse.parse()` step in the adapter is unaffected; it still
just receives a string or the call throws first).

This is intentionally not built on `politeFetch`: `politeFetch`'s delay/jitter/backoff
model is designed around repeated HTTP requests with machine-readable status codes
(`429`, `Retry-After`), which doesn't map onto a single browser navigation. KWSP's
fetcher gets its own small, bounded retry instead — `politeFetch` itself is unchanged
and continues to serve MyProcurement and SPAN.

## Wiring (`backend/src/index.ts`)

```diff
- new KwspAdapter(createPoliteFetcher({ responseType: 'text' })),
+ new KwspAdapter(createKwspBrowserFetchImpl()),
```

No other change to `index.ts`. `KwspAdapter`'s constructor signature
(`(fetcher: (url: string) => Promise<unknown>)`) is unchanged.

## Docker (`backend/Dockerfile`)

```diff
- FROM node:22-alpine
+ FROM mcr.microsoft.com/playwright:v<X.Y.Z>-noble
```

(`<X.Y.Z>` pinned to exactly match the `playwright` version in `backend/package.json`, per
Playwright's own guidance for avoiding a redundant browser download during
`npm ci` inside the image build.) The rest of the Dockerfile — `WORKDIR`, the `COPY`
steps, `npm ci --omit=dev --ignore-scripts ...`, `ENV DATA_DIR`, `EXPOSE`, `CMD` — is
unchanged. `frontend/Dockerfile` and `docker-compose.yml` are untouched.

## Local dev

`playwright` (the full package, not the lighter `playwright-core`) becomes a real
dependency of `backend`. Installing it triggers its own postinstall step that downloads
the Chrome browser build it needs automatically — no manual setup step. That download is
cached once per machine (Playwright's global browser cache), not per project or
worktree, so only the very first `npm install` after this change pays that cost on a
given machine.

## Testing / TDD

- `backend/test/kwspBrowserFetchImpl.test.ts`: mirrors
  `backend/test/spanFetchImpl.test.ts`'s approach — inject a fake `launchChromium` that
  returns a fake `Browser`/`Page` (fake `newPage`, `goto`, `waitForSelector`, `content`,
  `close`), so the suite never launches a real browser or touches the real network,
  matching the project-wide rule that tests must never hit a real external site. Cases:
  - Happy path: launches once, navigates to the given URL, waits for the selector,
    returns `page.content()`, closes the page and browser.
  - Retry: first attempt's `waitForSelector` rejects (simulating an uncleared
    challenge), second attempt succeeds — returns the second attempt's content, browser
    launched twice, both browsers closed.
  - Exhausted retries: both attempts fail — throws a clear error, both browsers still
    closed (never leaked even on failure).
  - Custom `User-Agent` is passed to `newPage`, not the other sources' bot-identifying
    string.
- `backend/test/kwspAdapter.test.ts`: **unchanged** — it already injects a fake fetcher
  function and has no knowledge of Playwright.
- No fixture HTML changes needed — `parseListing.ts`'s existing tests and fixtures are
  untouched, since the HTML shape KWSP returns hasn't changed, only how it's fetched.

## Out of scope (this iteration)

- Extracting additional data from KWSP (e.g. winner prices, currently always `null`)
  — unrelated to this fetch-mechanism change.
- Stealth/anti-detection tooling — not needed per the passing throwaway test; revisit
  only if Cloudflare's KWSP configuration changes and plain Playwright starts failing.
- Changing MyProcurement's or SPAN's fetchers, or `politeFetch` itself.
- A persistent/warm browser process — revisit only if KWSP scrape latency becomes a
  real problem.
