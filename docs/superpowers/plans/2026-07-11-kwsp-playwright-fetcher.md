# KWSP Playwright-Based Fetcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace KWSP's fetch mechanism with a real headless-browser fetch (via Playwright) so it can get past the Cloudflare JavaScript challenge that currently blocks every plain HTTP request to KWSP's tender page, without changing anything about how the fetched HTML is parsed.

**Architecture:** A new, self-contained fetcher module (`kwspBrowserFetchImpl.ts`) wraps a Playwright-driven Chrome browser behind the exact same `(url: string) => Promise<unknown>` function shape every scraper adapter already expects — mirroring the existing `spanFetchImpl.ts` pattern for a source-specific network requirement. `KwspAdapter` and its parser are completely unchanged; only what gets passed into its constructor changes. This requires moving the backend's Docker image (and, for consistency, the whole project) onto a base that actually bundles Chrome's dependencies and, incidentally, a newer Node version.

**Tech Stack:** Playwright (Node driver, Chromium), TypeScript (ESM), vitest.

## Global Constraints

- ESM everywhere: relative imports use `.js` extensions, matching every existing file in `backend/src/scrapers/`.
- TDD non-negotiable: write the failing test first, confirm it fails for the right reason, write minimal implementation, confirm it passes, commit immediately after green — never commit red.
- Tests must never hit a real external site. This plan's new tests inject a fake browser launcher; nothing in this plan's automated verification navigates a real browser to `kwsp.gov.my` or any other live site.
- Coverage thresholds (80% lines/branches) are enforced by vitest; pre-commit runs the full workspace suite (`npm test`) — do not lower thresholds or skip hooks.
- The project is on Node 22 today. Task 3 moves the whole project — both Dockerfiles and `CLAUDE.md` — to Node 24 together, because Playwright's latest Docker image (which Task 3 also adopts) bundles Node 24. Tasks 1 and 2 don't depend on this and can run under whatever Node version is already on the machine doing the work.
- `playwright`'s npm package version and the Docker image tag must stay in exact lockstep: both pinned to `1.61.1` (Task 1) / `v1.61.1-noble` (Task 3). The backend Dockerfile's `npm ci --ignore-scripts` skips Playwright's own postinstall browser download, so the exact matching browser build must already be present in the base image — a version mismatch here is a runtime failure, not just wasted bandwidth.

---

## File Structure

- **Create:** `backend/src/scrapers/kwsp/kwspBrowserFetchImpl.ts` — the Playwright-driven fetcher. One responsibility: turn a URL into rendered HTML via a real browser, retrying once on failure.
- **Create:** `backend/test/kwspBrowserFetchImpl.test.ts` — unit tests using an injected fake browser launcher.
- **Modify:** `backend/package.json` — add `playwright` as a pinned dependency; bump `@types/node`.
- **Modify:** `backend/src/index.ts` — construct `KwspAdapter` with the new fetcher instead of `createPoliteFetcher`.
- **Modify:** `backend/Dockerfile` — base image becomes Playwright's official image.
- **Modify:** `frontend/Dockerfile` — base image's Node version bumps to match.
- **Modify:** `CLAUDE.md` — stated Node version bumps to match.

---

### Task 1: Playwright-based KWSP fetcher

**Files:**
- Modify: `backend/package.json` (add `playwright` dependency)
- Create: `backend/src/scrapers/kwsp/kwspBrowserFetchImpl.ts`
- Test: `backend/test/kwspBrowserFetchImpl.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks in this plan; Playwright's `chromium.launch()` API (`import { chromium, type Browser } from 'playwright'`).
- Produces: `createKwspBrowserFetchImpl(deps?: KwspBrowserFetchImplDeps): (url: string) => Promise<string>`, the sole export of `backend/src/scrapers/kwsp/kwspBrowserFetchImpl.ts`. Task 2 imports this exact name from `./scrapers/kwsp/kwspBrowserFetchImpl.js` and calls it with no arguments (`createKwspBrowserFetchImpl()`).

- [ ] **Step 1: Add the pinned `playwright` dependency**

Run: `npm install playwright@1.61.1 -w backend`

This adds `playwright` to `backend/package.json`'s `dependencies` at exactly `1.61.1` and updates the root `package-lock.json`. It also triggers Playwright's own postinstall step, which downloads the matching Chrome browser build to a machine-global cache (not part of `node_modules`, not something to commit) — this is a one-time download on this machine, expected to take a few minutes.

- [ ] **Step 2: Write the failing test file**

Create `backend/test/kwspBrowserFetchImpl.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createKwspBrowserFetchImpl } from '../src/scrapers/kwsp/kwspBrowserFetchImpl.js';

function fakePage(overrides: {
  goto?: () => Promise<void>;
  waitForSelector?: () => Promise<void>;
  content?: () => Promise<string>;
} = {}) {
  return {
    goto: vi.fn(overrides.goto ?? (async () => {})),
    waitForSelector: vi.fn(overrides.waitForSelector ?? (async () => {})),
    content: vi.fn(overrides.content ?? (async () => '<html>real content</html>')),
    close: vi.fn(async () => {}),
  };
}

function fakeBrowser(page: ReturnType<typeof fakePage>) {
  return {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
  };
}

const URL = 'https://www.kwsp.gov.my/en/corporate/procurement/tenders';

describe('createKwspBrowserFetchImpl', () => {
  it('launches once, navigates, waits for the selector, and returns page content', async () => {
    const page = fakePage();
    const browser = fakeBrowser(page);
    const launchChromium = vi.fn(async () => browser as never);

    const fetchViaBrowser = createKwspBrowserFetchImpl({ launchChromium });
    const html = await fetchViaBrowser(URL);

    expect(html).toBe('<html>real content</html>');
    expect(launchChromium).toHaveBeenCalledTimes(1);
    expect(launchChromium).toHaveBeenCalledWith({ headless: true });
    expect(page.goto).toHaveBeenCalledWith(URL, { timeout: 20000 });
    expect(page.waitForSelector).toHaveBeenCalledWith('div.card-bg', { timeout: 20000 });
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('passes a realistic desktop Chrome User-Agent, not the bot-identifying one other sources use', async () => {
    const page = fakePage();
    const browser = fakeBrowser(page);
    const launchChromium = vi.fn(async () => browser as never);

    const fetchViaBrowser = createKwspBrowserFetchImpl({ launchChromium });
    await fetchViaBrowser(URL);

    expect(browser.newPage).toHaveBeenCalledWith({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
  });

  it('retries once with a fresh browser when the selector never appears, then succeeds', async () => {
    const failingPage = fakePage({
      waitForSelector: async () => { throw new Error('timeout waiting for selector'); },
    });
    const succeedingPage = fakePage({ content: async () => '<html>second attempt content</html>' });
    const failingBrowser = fakeBrowser(failingPage);
    const succeedingBrowser = fakeBrowser(succeedingPage);
    const launchChromium = vi.fn()
      .mockResolvedValueOnce(failingBrowser as never)
      .mockResolvedValueOnce(succeedingBrowser as never);

    const fetchViaBrowser = createKwspBrowserFetchImpl({ launchChromium, maxAttempts: 2 });
    const html = await fetchViaBrowser(URL);

    expect(html).toBe('<html>second attempt content</html>');
    expect(launchChromium).toHaveBeenCalledTimes(2);
    expect(failingBrowser.close).toHaveBeenCalledTimes(1); // closed even though the attempt failed
    expect(succeedingBrowser.close).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error after exhausting all retries, having closed every browser it opened', async () => {
    const failingPage = fakePage({
      waitForSelector: async () => { throw new Error('timeout waiting for selector'); },
    });
    const browser1 = fakeBrowser(failingPage);
    const browser2 = fakeBrowser(failingPage);
    const launchChromium = vi.fn()
      .mockResolvedValueOnce(browser1 as never)
      .mockResolvedValueOnce(browser2 as never);

    const fetchViaBrowser = createKwspBrowserFetchImpl({ launchChromium, maxAttempts: 2 });

    await expect(fetchViaBrowser(URL)).rejects.toThrow(
      'kwsp: page did not render past Cloudflare challenge after 2 attempt(s)',
    );
    expect(launchChromium).toHaveBeenCalledTimes(2);
    expect(browser1.close).toHaveBeenCalledTimes(1);
    expect(browser2.close).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w backend -- kwspBrowserFetchImpl`
Expected: FAIL — `Cannot find module '../src/scrapers/kwsp/kwspBrowserFetchImpl.js'` (the file doesn't exist yet).

- [ ] **Step 4: Write the minimal implementation**

Create `backend/src/scrapers/kwsp/kwspBrowserFetchImpl.ts`:

```ts
import { chromium as realChromium, type Browser } from 'playwright';

export interface KwspBrowserFetchImplDeps {
  launchChromium?: (opts: { headless: boolean }) => Promise<Browser>;
  waitSelector?: string;
  navigationTimeoutMs?: number;
  maxAttempts?: number;
  userAgent?: string;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** A browser-driven fetch implementation scoped to KWSP alone: its tender page sits behind a
 * Cloudflare JavaScript challenge that a plain HTTP request can never pass (no JS engine to
 * solve it), but a real headless browser clears on the first request. See
 * docs/superpowers/specs/2026-07-11-kwsp-playwright-fetcher-design.md for the investigation. */
export function createKwspBrowserFetchImpl(deps: KwspBrowserFetchImplDeps = {}): (url: string) => Promise<string> {
  const launchChromium = deps.launchChromium ?? ((opts) => realChromium.launch(opts));
  const waitSelector = deps.waitSelector ?? 'div.card-bg';
  const navigationTimeoutMs = deps.navigationTimeoutMs ?? 20000;
  const maxAttempts = deps.maxAttempts ?? 2;
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;

  return async function fetchViaBrowser(url: string): Promise<string> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const browser = await launchChromium({ headless: true });
      try {
        const page = await browser.newPage({ userAgent });
        try {
          await page.goto(url, { timeout: navigationTimeoutMs });
          await page.waitForSelector(waitSelector, { timeout: navigationTimeoutMs });
          return await page.content();
        } finally {
          await page.close();
        }
      } catch (err) {
        lastError = err;
      } finally {
        await browser.close();
      }
    }

    throw new Error(
      `kwsp: page did not render past Cloudflare challenge after ${maxAttempts} attempt(s): ${String(lastError)}`,
    );
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w backend -- kwspBrowserFetchImpl`
Expected: PASS — 4 tests passing in `kwspBrowserFetchImpl.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add backend/package.json package-lock.json backend/src/scrapers/kwsp/kwspBrowserFetchImpl.ts backend/test/kwspBrowserFetchImpl.test.ts
git commit -m "$(cat <<'EOF'
feat(backend): add Playwright-based KWSP fetcher

KWSP's tender page is behind a Cloudflare JS challenge that no plain
HTTP request can pass. A real headless browser clears it on the first
request (verified against the live site). Retries once with a fresh
browser before giving up.
EOF
)"
```

---

### Task 2: Wire the browser fetcher into the app

**Files:**
- Modify: `backend/src/index.ts`

**Interfaces:**
- Consumes: `createKwspBrowserFetchImpl` from `./scrapers/kwsp/kwspBrowserFetchImpl.js` (Task 1).
- Produces: nothing new — this task only changes what `KwspAdapter` is constructed with.

- [ ] **Step 1: Update the import and adapter construction**

In `backend/src/index.ts`, change the import block (currently lines 1–10):

```ts
import { MyProcurementAdapter } from './scrapers/myprocurement/adapter.js';
import { SpanAdapter } from './scrapers/span/adapter.js';
import { KwspAdapter } from './scrapers/kwsp/adapter.js';
import { createSpanFetchImpl } from './scrapers/span/spanFetchImpl.js';
import { createPoliteFetcher } from './http/politeFetch.js';
import { TenderRepository } from './storage/repository.js';
import { ScrapeManager } from './scrape/manager.js';
import { createApp } from './api/app.js';
import { decideStartupPolicy } from './startupPolicy.js';
import { resolveDataDir } from './resolveDataDir.js';
```

to:

```ts
import { MyProcurementAdapter } from './scrapers/myprocurement/adapter.js';
import { SpanAdapter } from './scrapers/span/adapter.js';
import { KwspAdapter } from './scrapers/kwsp/adapter.js';
import { createSpanFetchImpl } from './scrapers/span/spanFetchImpl.js';
import { createKwspBrowserFetchImpl } from './scrapers/kwsp/kwspBrowserFetchImpl.js';
import { createPoliteFetcher } from './http/politeFetch.js';
import { TenderRepository } from './storage/repository.js';
import { ScrapeManager } from './scrape/manager.js';
import { createApp } from './api/app.js';
import { decideStartupPolicy } from './startupPolicy.js';
import { resolveDataDir } from './resolveDataDir.js';
```

Then change the adapters array (currently):

```ts
  const adapters = [
    new MyProcurementAdapter(createPoliteFetcher()),
    new SpanAdapter(createPoliteFetcher({ responseType: 'text', fetchImpl: createSpanFetchImpl() })),
    new KwspAdapter(createPoliteFetcher({ responseType: 'text' })),
  ];
```

to:

```ts
  const adapters = [
    new MyProcurementAdapter(createPoliteFetcher()),
    new SpanAdapter(createPoliteFetcher({ responseType: 'text', fetchImpl: createSpanFetchImpl() })),
    new KwspAdapter(createKwspBrowserFetchImpl()),
  ];
```

`KwspAdapter`'s constructor signature (`(fetcher: (url: string) => Promise<unknown>)`) doesn't change, and neither does anything else in `index.ts`.

- [ ] **Step 2: Run the full backend test suite to confirm no regressions**

Run: `npm test -w backend`
Expected: PASS — every existing test still passes, including `backend/test/kwspAdapter.test.ts` (which is untouched by this plan — it already injects a fake fetcher and has no knowledge of how `index.ts` wires the real one) and Task 1's new `kwspBrowserFetchImpl.test.ts`.

There's no dedicated unit test for `index.ts`'s composition wiring in this codebase (its other adapters aren't tested this way either) — this is a straightforward substitution of one already-tested fetcher function for another, verified by the full suite staying green plus TypeScript accepting the new call (both `createPoliteFetcher(...)` and `createKwspBrowserFetchImpl()` satisfy the same `(url: string) => Promise<unknown>` parameter type `KwspAdapter`'s constructor expects).

- [ ] **Step 3: Commit**

```bash
git add backend/src/index.ts
git commit -m "$(cat <<'EOF'
feat(backend): use the Playwright-based fetcher for KWSP

Swaps KwspAdapter's fetcher from the plain-HTTP politeFetch (which
Cloudflare blocks) to the new browser-driven one. No other wiring
changes.
EOF
)"
```

---

### Task 3: Move the project to Node 24 (Docker + docs)

**Files:**
- Modify: `backend/Dockerfile`
- Modify: `frontend/Dockerfile`
- Modify: `backend/package.json` (`@types/node` bump)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nothing from other tasks — this task is independent of Tasks 1–2's application code, but the backend Docker image it produces is what actually runs Task 1's fetcher in production, so it must build and launch Chromium successfully.
- Produces: nothing other tasks consume; this is the final task in the plan.

- [ ] **Step 1: Update `backend/Dockerfile`'s base image**

In `backend/Dockerfile`, change line 1 from:

```dockerfile
FROM node:22-alpine
```

to:

```dockerfile
FROM mcr.microsoft.com/playwright:v1.61.1-noble
```

No other line in `backend/Dockerfile` changes — `WORKDIR /app`, the `COPY` steps, `npm ci --omit=dev --ignore-scripts --workspace shared --workspace backend`, `ENV DATA_DIR=/app/data`, `EXPOSE 3001`, and the `CMD` all stay exactly as they are.

- [ ] **Step 2: Update `frontend/Dockerfile`'s base image**

In `frontend/Dockerfile`, change line 1 from:

```dockerfile
FROM node:22-alpine AS build
```

to:

```dockerfile
FROM node:24-alpine AS build
```

No other line in `frontend/Dockerfile` changes (the second stage, `FROM nginx:alpine`, is untouched — it never depended on the Node version).

- [ ] **Step 3: Bump `@types/node` to match**

In `backend/package.json`, change the `devDependencies` entry:

```json
    "@types/node": "^22.0.0",
```

to:

```json
    "@types/node": "^24.0.0",
```

Then run: `npm install -w backend` to update `package-lock.json` accordingly.

- [ ] **Step 4: Update `CLAUDE.md`**

In `CLAUDE.md`, under `## Stack`, change:

```markdown
- Node 22, TypeScript, ESM everywhere.
```

to:

```markdown
- Node 24, TypeScript, ESM everywhere.
```

- [ ] **Step 5: Run the backend test suite locally**

Run: `npm test -w backend`
Expected: PASS — the `@types/node` bump is a type-declarations-only change; it shouldn't affect any test's runtime behavior. (This confirms nothing regressed before spending time on the slower Docker build check next.)

- [ ] **Step 6: Build and verify the backend Docker image**

Run, from the repository root (`C:/Projects/tms-v2`):

```bash
docker build -f backend/Dockerfile -t tms-kwsp-verify-backend:latest .
```

Expected: the build completes successfully (this pulls Playwright's `v1.61.1-noble` base image if not already cached locally — that alone can take several minutes on first run; this is expected, not a failure).

Then run:

```bash
docker run --rm tms-kwsp-verify-backend:latest node --version
```

Expected: prints a `v24.x.x` version string.

Then run:

```bash
docker run --rm tms-kwsp-verify-backend:latest node -e "
const { chromium } = require('playwright');
chromium.launch({ headless: true }).then(async (b) => {
  console.log('LAUNCH_OK', b.version());
  await b.close();
}).catch((e) => { console.error('LAUNCH_FAIL', e); process.exit(1); });
"
```

Expected: prints `LAUNCH_OK <chrome-version>` and exits with code 0. This confirms the browser build baked into Playwright's image is actually usable from the `playwright` npm package installed via `npm ci` in this same image — the specific risk called out in Global Constraints (a version mismatch between the two would fail here, not silently).

This step deliberately does not navigate to any real external site — it only proves Chromium can launch inside the built image. (Verifying the fetcher actually clears KWSP's Cloudflare challenge when run for real is a manual check to do afterward, the same way SPAN's detail-page scraping was verified against the live site after that plan was implemented — not part of this automated plan.)

Clean up the test image:

```bash
docker rmi tms-kwsp-verify-backend:latest
```

- [ ] **Step 7: Build and verify the frontend Docker image**

Run, from the repository root:

```bash
docker build -f frontend/Dockerfile -t tms-kwsp-verify-frontend:latest .
```

Expected: the build completes successfully (confirms the Node 24 bump doesn't break the frontend's `npm ci` / `npm run build -w frontend` step).

Clean up the test image:

```bash
docker rmi tms-kwsp-verify-frontend:latest
```

- [ ] **Step 8: Commit**

```bash
git add backend/Dockerfile frontend/Dockerfile backend/package.json package-lock.json CLAUDE.md
git commit -m "$(cat <<'EOF'
build: move the project to Node 24, backend onto Playwright's Docker image

Playwright's official Docker images (needed so the backend container
can run KWSP's headless-browser fetcher) bundle Node 24, not the
project's Node 22. Rather than split Node versions across containers,
the whole project — both Dockerfiles and CLAUDE.md — moves to Node 24
together.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** every decision in the design doc's table (Docker base image, Node version, browser lifecycle, stealth tooling, scope, retry model, testing approach) maps to a concrete step above. The design's "Out of scope" items (KWSP data extraction changes, MyProcurement/SPAN fetchers, `politeFetch` itself, a persistent browser) are untouched by every task.
- **Type consistency:** `createKwspBrowserFetchImpl`'s signature is identical everywhere it appears (design doc, Task 1's implementation, Task 1's test imports, Task 2's wiring) — `(deps?: KwspBrowserFetchImplDeps) => (url: string) => Promise<string>`, satisfying `KwspAdapter`'s existing `(url: string) => Promise<unknown>` constructor parameter.
- **No placeholders:** the Docker image tag, npm package version, user-agent string, selector, and error message are the same concrete values across the design doc, Task 1, and Task 3 — nothing left for the implementer to decide.
