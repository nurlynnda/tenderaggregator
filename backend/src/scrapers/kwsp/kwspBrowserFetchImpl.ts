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
