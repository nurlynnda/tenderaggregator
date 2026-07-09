import { z } from 'zod';
import type { ScrapeHooks, ScrapeOptions, ScrapeScope, ScraperAdapter } from '../types.js';
import { parseSpanListingHtml } from './parseListing.js';

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
      await hooks.onJobDone?.(name);
    }
  }
}
