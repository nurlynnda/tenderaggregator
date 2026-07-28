import { z } from 'zod';
import type { ScrapeHooks, ScrapeOptions, ScrapeScope, ScraperAdapter } from '../types.js';
import { parseListingHtml } from './parseListing.js';
import { parseResultsHtml } from './parseResults.js';

const BASE_URL = 'https://myprocurement.treasury.gov.my/procurements/fetch';
const ITEMS_PER_PAGE = 100;

export const MYPROCUREMENT_JOBS = [
  { status: 'open', procurementType: 'quotation', type: 'advertisements', category: 'quotation', kind: 'full' },
  { status: 'open', procurementType: 'tender', type: 'advertisements', category: 'tender', kind: 'full' },
  { status: 'open', procurementType: 'requisition', type: 'advertisements', category: 'requisition', kind: 'full' },
  { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'advertisement-quotation', kind: 'full' },
  { status: 'closed', procurementType: 'tender', type: 'archive', category: 'advertisement-tender', kind: 'full' },
  { status: 'closed', procurementType: 'requisition', type: 'archive', category: 'advertisement-requisition', kind: 'full' },
  { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'results-quotation', kind: 'results' },
  { status: 'closed', procurementType: 'tender', type: 'archive', category: 'results-tender', kind: 'results' },
  { status: 'closed', procurementType: 'quotation', type: 'results', category: 'quotation', kind: 'daily-results' },
  { status: 'closed', procurementType: 'tender', type: 'results', category: 'tender', kind: 'daily-results' },
] as const;

const ListingResponse = z.object({ html: z.string(), lastPage: z.number().int().min(1) });

type MyProcurementJob = (typeof MYPROCUREMENT_JOBS)[number];

function jobName(job: MyProcurementJob): string {
  if (job.kind === 'results') return `${job.status}-${job.procurementType}-results`;
  if (job.kind === 'daily-results') return `${job.procurementType}-keputusan`;
  return `${job.status}-${job.procurementType}`;
}

export class MyProcurementAdapter implements ScraperAdapter {
  readonly name = 'myprocurement';

  constructor(private readonly fetcher: (url: string) => Promise<unknown>) {}

  archiveJobNames(): string[] {
    return MYPROCUREMENT_JOBS.filter((j) => j.status === 'closed' && j.kind !== 'daily-results').map(jobName);
  }

  resultsJobNames(): string[] {
    return [];
  }

  async scrape(scope: ScrapeScope, hooks: ScrapeHooks, opts: ScrapeOptions = {}): Promise<void> {
    const jobs = MYPROCUREMENT_JOBS.filter((j) => {
      const inScope = scope === 'all' ? true
        : scope === 'open' ? (j.status === 'open' || j.kind === 'daily-results')
        : j.status === 'closed';
      if (!inScope) return false;
      if (j.status === 'closed' && j.kind !== 'daily-results' && opts.skipJobNames?.has(jobName(j))) return false; // already backfilled
      return true;
    });

    for (const [jobIndex, job] of jobs.entries()) {
      if (opts.isCancelled?.()) return;
      const name = jobName(job);
      let page = 1;
      let lastPage = 1;
      do {
        if (opts.isCancelled?.()) return;
        const url = `${BASE_URL}?page=${page}&itemsPerPage=${ITEMS_PER_PAGE}&type=${job.type}&category=${job.category}`;
        const body = ListingResponse.parse(await this.fetcher(url));
        lastPage = body.lastPage;
        hooks.onProgress({
          source: this.name,
          job: name,
          jobsCompleted: jobIndex,
          jobsTotal: jobs.length,
          currentPage: page,
          lastPage,
        });
        const patches = job.kind === 'results' || job.kind === 'daily-results'
          ? parseResultsHtml(body.html, { procurementType: job.procurementType })
          : parseListingHtml(body.html, { status: job.status, procurementType: job.procurementType });
        await hooks.onBatch(patches);
        page += 1;
      } while (page <= lastPage);
      await hooks.onJobDone?.(name);
    }
  }
}
