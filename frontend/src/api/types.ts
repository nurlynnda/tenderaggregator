import type { Tender } from '@tms/shared';
export type { Tender };

export interface TenderPage { items: Tender[]; total: number; page: number; pageSize: number }
export interface Facets {
  ministries: string[]; agencies: string[]; categories: string[]; sources: string[];
  procurementTypes: string[]; fieldCodes: string[];
}
export interface ScrapeStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  source?: string; job?: string;
  jobsCompleted?: number; jobsTotal?: number;
  currentPage?: number; lastPage?: number;
  error?: string;
}
export interface ScrapeSource {
  name: string;
  lastScrapedAt: string | null;
  lastArchiveBackfillAt: string | null;
  total: number;
}
export interface TenderDetail { tender: Tender }
export interface MinistryStat { ministry: string; totalValue: number; count: number }
export interface ContractorStat { name: string; wins: number; totalValue: number }
export interface YearStat { year: number; totalValue: number }
export interface DashboardStats {
  totalAwardedValue: number;
  totalAwardedCount: number;
  excludedFromValueCount: number;
  byMinistry: MinistryStat[];
  topContractors: ContractorStat[];
  byYear: YearStat[];
}
