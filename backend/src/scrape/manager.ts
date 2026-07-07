import type { ScrapeScope, ScraperAdapter } from '../scrapers/types.js';
import type { TenderRepository } from '../storage/repository.js';

export interface ScrapeStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  source?: string;
  job?: string;
  jobsCompleted?: number;
  jobsTotal?: number;
  currentPage?: number;
  lastPage?: number;
  error?: string;
}

export class ScrapeManager {
  private current: ScrapeStatus = { state: 'idle' };
  private running = false;

  constructor(
    private readonly adapters: ScraperAdapter[],
    private readonly repo: TenderRepository,
    private readonly opts: { flushEveryPages?: number; now?: () => string } = {},
  ) {}

  status(): ScrapeStatus {
    return { ...this.current };
  }

  start(scope: ScrapeScope): boolean {
    if (this.running) return false;
    void this.runToCompletion(scope);
    return true;
  }

  async runToCompletion(scope: ScrapeScope): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.current = { state: 'running' };
    const now = this.opts.now ?? (() => new Date().toISOString());
    const flushEvery = this.opts.flushEveryPages ?? 10;

    try {
      for (const adapter of this.adapters) {
        let pagesSinceFlush = 0;
        await adapter.scrape(scope, {
          onProgress: (p) => {
            this.current = { state: 'running', ...p };
          },
          onBatch: async (tenders) => {
            this.repo.upsertMany(adapter.name, tenders);
            pagesSinceFlush += 1;
            if (pagesSinceFlush >= flushEvery) {
              await this.repo.flush(adapter.name);
              pagesSinceFlush = 0;
            }
          },
        });
        await this.repo.flush(adapter.name);
        const stamp: Parameters<TenderRepository['setMeta']>[1] = { lastScrapedAt: now() };
        if (scope === 'all' || scope === 'archive') stamp.lastArchiveBackfillAt = now();
        await this.repo.setMeta(adapter.name, stamp);
      }
      this.current = { state: 'done' };
    } catch (err) {
      this.current = { state: 'failed', error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.running = false;
    }
  }
}
