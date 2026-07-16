import { z } from 'zod';
import type { ScrapeHooks, ScrapeOptions, ScrapeScope, ScraperAdapter } from '../types.js';
import { parseLlmListingHtml } from './parseListing.js';
import { parseLlmDetailHtml } from './parseDetail.js';

const LISTING_URL = 'https://www.llm.gov.my/swasta/tender_tawaran';
const PAGE_SIZE = 6;
const JOB_NAME = 'open';

const HtmlResponse = z.string().min(1);

export class LlmAdapter implements ScraperAdapter {
  readonly name = 'llm';

  constructor(
    private readonly fetcher: (url: string) => Promise<unknown>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  archiveJobNames(): string[] {
    return []; // this source publishes only currently-open tenders, no closed/archive listing
  }

  resultsJobNames(): string[] {
    return [];
  }

  async scrape(scope: ScrapeScope, hooks: ScrapeHooks, opts: ScrapeOptions = {}): Promise<void> {
    if (scope === 'archive') return; // no archive job exists for this source

    if (opts.isCancelled?.()) return;

    const links: { sourceId: string; sourceUrl: string }[] = [];
    let offset = 0;
    for (;;) {
      if (opts.isCancelled?.()) return;
      const url = offset === 0 ? `${LISTING_URL}/` : `${LISTING_URL}/${offset}`;
      const html = HtmlResponse.parse(await this.fetcher(url));
      const pageLinks = parseLlmListingHtml(html);
      if (pageLinks.length === 0) break;
      links.push(...pageLinks);
      offset += PAGE_SIZE;
    }

    for (const [index, link] of links.entries()) {
      if (opts.isCancelled?.()) return;
      hooks.onProgress({
        source: this.name,
        job: JOB_NAME,
        jobsCompleted: 0,
        jobsTotal: 1,
        currentPage: index + 1,
        lastPage: links.length,
      });

      let patch;
      try {
        const detailHtml = HtmlResponse.parse(await this.fetcher(link.sourceUrl));
        patch = parseLlmDetailHtml(detailHtml, { sourceId: link.sourceId, sourceUrl: link.sourceUrl, now: this.now });
      } catch (err) {
        console.warn(`[llm] skipping detail fetch for ${link.sourceUrl}: ${err}`);
        continue;
      }
      if (patch) await hooks.onBatch([patch]);
    }

    await hooks.onJobDone?.(JOB_NAME);
  }
}
