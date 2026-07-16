import { z } from 'zod';
import type { Winner } from '@tms/shared';
import type { ScrapeHooks, ScrapeOptions, ScrapeScope, ScraperAdapter } from '../types.js';
import { parseLlmListingHtml } from './parseListing.js';
import { parseLlmDetailHtml } from './parseDetail.js';
import { parseLlmResultsHtml } from './parseResults.js';

const OPEN_LISTING_URL = 'https://www.llm.gov.my/swasta/tender_tawaran';
const RESULTS_LISTING_URL = 'https://www.llm.gov.my/swasta/tender_keputusan';
const PAGE_SIZE = 6;

const HtmlResponse = z.string().min(1);

interface LlmJob {
  name: 'open' | 'closed';
  status: 'open' | 'closed';
  listingUrl: string;
  /**
   * Whether to keep requesting listingUrl/6, /12, ... until an empty page. The open listing
   * paginates fine this way, but llm.gov.my's own "Keputusan" (results) pagination links point
   * to URLs that 404 on their server past page 1 (verified directly against the live site) — so
   * for that job we only ever fetch the first page.
   */
  paginate: boolean;
}

interface DiscoveredLink {
  sourceId: string;
  sourceUrl: string;
  winner: Winner | null;
}

const ALL_JOBS: LlmJob[] = [
  { name: 'open', status: 'open', listingUrl: OPEN_LISTING_URL, paginate: true },
  { name: 'closed', status: 'closed', listingUrl: RESULTS_LISTING_URL, paginate: false },
];

export class LlmAdapter implements ScraperAdapter {
  readonly name = 'llm';

  constructor(
    private readonly fetcher: (url: string) => Promise<unknown>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  archiveJobNames(): string[] {
    return ['closed']; // awarded/closed tenders come from the separate "Keputusan" listing
  }

  resultsJobNames(): string[] {
    return ['closed']; // that same listing is also where the winner/award data lives
  }

  async scrape(scope: ScrapeScope, hooks: ScrapeHooks, opts: ScrapeOptions = {}): Promise<void> {
    const jobs = ALL_JOBS.filter((j) => {
      const inScope = scope === 'all' ? true : scope === 'open' ? j.name === 'open' : j.name === 'closed';
      if (!inScope) return false;
      if (j.name === 'closed' && opts.skipJobNames?.has('closed')) return false;
      return true;
    });

    for (const [jobIndex, job] of jobs.entries()) {
      if (opts.isCancelled?.()) return;

      const links = await this.discoverLinks(job, opts);
      if (opts.isCancelled?.()) return;

      for (const [index, link] of links.entries()) {
        if (opts.isCancelled?.()) return;
        hooks.onProgress({
          source: this.name,
          job: job.name,
          jobsCompleted: jobIndex,
          jobsTotal: jobs.length,
          currentPage: index + 1,
          lastPage: links.length,
        });

        let patch;
        try {
          const detailHtml = HtmlResponse.parse(await this.fetcher(link.sourceUrl));
          patch = parseLlmDetailHtml(detailHtml, {
            sourceId: link.sourceId,
            sourceUrl: link.sourceUrl,
            status: job.status,
            now: this.now,
          });
        } catch (err) {
          console.warn(`[llm] skipping detail fetch for ${link.sourceUrl}: ${err}`);
          continue;
        }
        if (!patch) continue;
        if (job.name === 'closed') {
          patch = { ...patch, winners: link.winner ? [link.winner] : null };
        }
        await hooks.onBatch([patch]);
      }

      await hooks.onJobDone?.(job.name);
    }
  }

  private async discoverLinks(job: LlmJob, opts: ScrapeOptions): Promise<DiscoveredLink[]> {
    const links: DiscoveredLink[] = [];
    let offset = 0;
    for (;;) {
      if (opts.isCancelled?.()) return links;
      const url = offset === 0 ? `${job.listingUrl}/` : `${job.listingUrl}/${offset}`;
      const html = HtmlResponse.parse(await this.fetcher(url));

      if (job.name === 'open') {
        const pageLinks = parseLlmListingHtml(html);
        if (pageLinks.length === 0) break;
        links.push(...pageLinks.map((l) => ({ ...l, winner: null })));
      } else {
        const pageRows = parseLlmResultsHtml(html);
        if (pageRows.length === 0) break;
        links.push(...pageRows);
      }
      if (!job.paginate) break;
      offset += PAGE_SIZE;
    }
    return links;
  }
}
