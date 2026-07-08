import type { Tender } from '@tms/shared';
export type { Tender };

export interface TenderPage { items: Tender[]; total: number; page: number; pageSize: number }
export interface Facets {
  ministries: string[]; agencies: string[]; categories: string[];
  procurementTypes: string[]; fieldCodes: string[];
}
export interface ScrapeStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  source?: string; job?: string;
  jobsCompleted?: number; jobsTotal?: number;
  currentPage?: number; lastPage?: number;
  error?: string;
}
export interface TenderDetail { tender: Tender }
