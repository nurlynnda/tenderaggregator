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
