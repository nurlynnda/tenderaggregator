import type { Tender } from '@tms/shared';

export type ScrapeScope = 'all' | 'open' | 'archive';

export interface ScrapeProgress {
  source: string;
  job: string;
  jobsCompleted: number;
  jobsTotal: number;
  currentPage: number;
  lastPage: number;
}

export interface ScrapeHooks {
  onProgress: (p: ScrapeProgress) => void;
  onBatch: (tenders: Tender[]) => Promise<void>;
}

export interface ScraperAdapter {
  name: string;
  scrape(scope: ScrapeScope, hooks: ScrapeHooks): Promise<void>;
}
