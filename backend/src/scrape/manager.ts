import type { ScrapeScope, ScraperAdapter } from '../scrapers/types.js';
import type { TenderRepository } from '../storage/repository.js';

export interface ScrapeStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
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
  private cancelRequested = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly adapters: ScraperAdapter[],
    private readonly repo: TenderRepository,
    private readonly opts: { now?: () => string } = {},
  ) {}

  status(): ScrapeStatus {
    return { ...this.current };
  }

  cancel(): boolean {
    if (!this.running) return false;
    this.cancelRequested = true;
    return true;
  }

  async waitUntilIdle(): Promise<void> {
    if (!this.running) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  async listSources(): Promise<Array<{ name: string; lastScrapedAt: string | null; lastArchiveBackfillAt: string | null; total: number }>> {
    return Promise.all(
      this.adapters.map(async (a) => {
        const meta = await this.repo.getMeta(a.name);
        return { name: a.name, lastScrapedAt: meta.lastScrapedAt, lastArchiveBackfillAt: meta.lastArchiveBackfillAt, total: meta.total };
      }),
    );
  }

  start(scope: ScrapeScope, opts: { sourceName?: string } = {}): boolean {
    if (this.running) return false;
    void this.runToCompletion(scope, opts);
    return true;
  }

  /**
   * Clears just the given source's *results* job names (per its adapter's resultsJobNames())
   * from its persisted completedArchiveJobs, then re-runs an archive-scope scrape for that
   * source — the existing skip-already-completed-job logic in each adapter's scrape() then
   * naturally re-runs only those jobs, leaving already-complete advertisement/listing jobs
   * alone. Returns false (same convention as start()) when a scrape is already running, the
   * source name matches no registered adapter, or the adapter has no results jobs at all.
   *
   * `this.running` is set synchronously as a reservation flag BEFORE the first `await`, then
   * released in a `finally` before calling `start()` (which re-acquires it properly). This
   * closes the race that would otherwise exist now that repo.getMeta()/setMeta() are real
   * async Mongo calls: without the synchronous reservation, two concurrent refreshResults()
   * calls (or a refreshResults() racing a start()) could both observe `this.running === false`
   * and both proceed past the guard before either one's Mongo round-trip resolves.
   */
  async refreshResults(sourceName: string): Promise<boolean> {
    if (this.running) return false;
    const adapter = this.adapters.find((a) => a.name === sourceName);
    if (!adapter) return false;
    const results = new Set(adapter.resultsJobNames?.() ?? []);
    if (results.size === 0) return false;
    this.running = true;
    try {
      const meta = await this.repo.getMeta(sourceName);
      const remaining = meta.completedArchiveJobs.filter((j) => !results.has(j));
      await this.repo.setMeta(sourceName, { completedArchiveJobs: remaining });
    } finally {
      this.running = false;
    }
    return this.start('archive', { sourceName });
  }

  async runToCompletion(scope: ScrapeScope, opts: { sourceName?: string } = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelRequested = false;
    this.current = { state: 'running' };
    const now = this.opts.now ?? (() => new Date().toISOString());
    const adapters = opts.sourceName ? this.adapters.filter((a) => a.name === opts.sourceName) : this.adapters;
    let activeSource: string | undefined;

    try {
      for (const adapter of adapters) {
        if (this.cancelRequested) break;
        activeSource = adapter.name;
        this.current = { state: 'running', source: activeSource };
        const completedArchiveJobs = new Set((await this.repo.getMeta(adapter.name)).completedArchiveJobs);
        await adapter.scrape(
          scope,
          {
            onProgress: (p) => {
              this.current = { state: 'running', ...p };
            },
            onBatch: async (patches) => {
              await this.repo.mergeMany(patches);
            },
            onJobDone: async (jobName) => {
              completedArchiveJobs.add(jobName);
              await this.repo.setMeta(adapter.name, { completedArchiveJobs: [...completedArchiveJobs] });
            },
          },
          { skipJobNames: completedArchiveJobs, isCancelled: () => this.cancelRequested },
        );
        if (this.cancelRequested) break; // run didn't finish — don't stamp meta for this adapter
        const stamp: Parameters<TenderRepository['setMeta']>[1] = {
          lastScrapedAt: now(),
          total: await this.repo.getSourceCount(adapter.name),
        };
        if (scope === 'all' || scope === 'archive') stamp.lastArchiveBackfillAt = now();
        await this.repo.setMeta(adapter.name, stamp);
      }
      if (!this.cancelRequested) {
        await this.repo.reconcileStaleOpen(new Date(now()));
      }
      this.current = this.cancelRequested ? { state: 'cancelled', source: activeSource } : { state: 'done' };
    } catch (err) {
      this.current = { state: 'failed', source: activeSource, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}
