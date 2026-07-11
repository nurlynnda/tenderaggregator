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
