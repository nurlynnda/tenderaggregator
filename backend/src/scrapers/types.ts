import type { TenderPatch } from '@tms/shared';

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
  onBatch: (patches: TenderPatch[]) => Promise<void>;
  /** Called once a job has paginated through all its pages, before the next job starts. */
  onJobDone?: (jobName: string) => void | Promise<void>;
}

export interface ScrapeOptions {
  /** Closed/archive job names to skip (already completed in a prior backfill run). Open jobs are never skipped. */
  skipJobNames?: Set<string>;
}

export interface ScraperAdapter {
  name: string;
  scrape(scope: ScrapeScope, hooks: ScrapeHooks, opts?: ScrapeOptions): Promise<void>;
  /** The full set of closed/archive job names this adapter will ever run, used to detect newly added job kinds. */
  archiveJobNames(): string[];
}
