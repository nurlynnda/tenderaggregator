import { z } from 'zod';
import type { ScrapeHooks, ScrapeScope, ScraperAdapter } from '../types.js';
import { parseListingHtml } from './parseListing.js';

const BASE_URL = 'https://myprocurement.treasury.gov.my/procurements/fetch';
const ITEMS_PER_PAGE = 100;

export const MYPROCUREMENT_JOBS = [
  { status: 'open', procurementType: 'quotation', type: 'advertisements', category: 'quotation' },
  { status: 'open', procurementType: 'tender', type: 'advertisements', category: 'tender' },
  { status: 'open', procurementType: 'requisition', type: 'advertisements', category: 'requisition' },
  { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'advertisement-quotation' },
  { status: 'closed', procurementType: 'tender', type: 'archive', category: 'advertisement-tender' },
  { status: 'closed', procurementType: 'requisition', type: 'archive', category: 'advertisement-requisition' },
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
      const jobName = `${job.status}-${job.procurementType}`;
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
        const tenders = parseListingHtml(body.html, {
          status: job.status,
          procurementType: job.procurementType,
        });
        await hooks.onBatch(tenders);
        page += 1;
      } while (page <= lastPage);
    }
  }
}
