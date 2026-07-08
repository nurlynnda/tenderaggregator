import { z } from 'zod';
import type { ScrapeHooks, ScrapeScope, ScraperAdapter } from '../types.js';
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
] as const;

const ListingResponse = z.object({ html: z.string(), lastPage: z.number().int().min(1) });

export class MyProcurementAdapter implements ScraperAdapter {
  readonly name = 'myprocurement';

  constructor(private readonly fetcher: (url: string) => Promise<unknown>) {}

  async scrape(scope: ScrapeScope, hooks: ScrapeHooks): Promise<void> {
    const jobs = MYPROCUREMENT_JOBS.filter((j) =>
      scope === 'all' ? true : scope === 'open' ? j.status === 'open' : j.status === 'closed',
    );

    for (const [jobIndex, job] of jobs.entries()) {
      const jobName = job.kind === 'results'
        ? `${job.status}-${job.procurementType}-results`
        : `${job.status}-${job.procurementType}`;
      let page = 1;
      let lastPage = 1;
      do {
        const url = `${BASE_URL}?page=${page}&itemsPerPage=${ITEMS_PER_PAGE}&type=${job.type}&category=${job.category}`;
        const body = ListingResponse.parse(await this.fetcher(url));
        lastPage = body.lastPage;
        hooks.onProgress({
          source: this.name,
          job: jobName,
          jobsCompleted: jobIndex,
          jobsTotal: jobs.length,
          currentPage: page,
          lastPage,
        });
        const patches = job.kind === 'results'
          ? parseResultsHtml(body.html, { procurementType: job.procurementType })
          : parseListingHtml(body.html, { status: job.status, procurementType: job.procurementType });
        await hooks.onBatch(patches);
        page += 1;
      } while (page <= lastPage);
    }
  }
}
