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
    private readonly opts: {
      flushEveryPages?: number;
      /** Overrides flushEveryPages specifically for scope='open' (small, fast-feedback jobs). */
      flushEveryPagesOpen?: number;
      /** Overrides flushEveryPages specifically for scope='archive'/'all' (large backfill jobs). */
      flushEveryPagesArchive?: number;
      now?: () => string;
    } = {},
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

  listSources(): Array<{ name: string; lastScrapedAt: string | null; lastArchiveBackfillAt: string | null; total: number }> {
    return this.adapters.map((a) => {
      const meta = this.repo.getMeta(a.name);
      return { name: a.name, lastScrapedAt: meta.lastScrapedAt, lastArchiveBackfillAt: meta.lastArchiveBackfillAt, total: meta.total };
    });
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
   * repo.setMeta() is called without awaiting its returned promise: its in-memory map update
   * happens synchronously (before setMeta's first `await`), so by the time start() is called
   * on the next line — in the same synchronous tick — the trimmed completedArchiveJobs is
   * already visible to runToCompletion()'s own read of it. This also means start()'s own
   * synchronous `this.running = true` guard fires in that same tick, so there is no window
   * where a concurrent start()/refreshResults() call could race past the "already running"
   * check. (Chaining via `.then()` instead would leave exactly that race open, since the
   * disk-write portion of setMeta is real async I/O.)
   *
   * If the source's completedArchiveJobs is already empty (e.g. its initial archive
   * backfill never finished, or a fresh environment with no meta.json yet), there is
   * nothing to filter out and this degenerates into a full archive re-crawl of every job
   * for that source, not just its results jobs — harmless (a superset of the intended
   * work; winners still end up fetched correctly) but worth knowing before reading the
   * filter logic below.
   */
  refreshResults(sourceName: string): boolean {
    if (this.running) return false;
    const adapter = this.adapters.find((a) => a.name === sourceName);
    if (!adapter) return false;
    const results = new Set(adapter.resultsJobNames?.() ?? []);
    if (results.size === 0) return false;
    const remaining = this.repo.getMeta(sourceName).completedArchiveJobs.filter((j) => !results.has(j));
    void this.repo.setMeta(sourceName, { completedArchiveJobs: remaining });
    return this.start('archive', { sourceName });
  }

  async runToCompletion(scope: ScrapeScope, opts: { sourceName?: string } = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelRequested = false;
    this.current = { state: 'running' };
    const now = this.opts.now ?? (() => new Date().toISOString());
    const flushEvery =
      this.opts.flushEveryPages ??
      (scope === 'open' ? (this.opts.flushEveryPagesOpen ?? 10) : (this.opts.flushEveryPagesArchive ?? 50));
    const adapters = opts.sourceName ? this.adapters.filter((a) => a.name === opts.sourceName) : this.adapters;
    let activeSource: string | undefined;

    try {
      for (const adapter of adapters) {
        if (this.cancelRequested) break;
        activeSource = adapter.name;
        // Attributed immediately (not just once the adapter's first onProgress call lands), so the
        // UI can identify the running row — and show a Cancel button — from the very first tick.
        this.current = { state: 'running', source: activeSource };
        let pagesSinceFlush = 0;
        const completedArchiveJobs = new Set(this.repo.getMeta(adapter.name).completedArchiveJobs);
        await adapter.scrape(
          scope,
          {
            onProgress: (p) => {
              this.current = { state: 'running', ...p };
            },
            onBatch: async (patches) => {
              this.repo.mergeMany(patches);
              pagesSinceFlush += 1;
              if (pagesSinceFlush >= flushEvery) {
                await this.repo.flush();
                pagesSinceFlush = 0;
              }
            },
            onJobDone: async (jobName) => {
              // Persisted per job (not just at the end of the whole scrape) so a crash mid-backfill
              // resumes only the jobs that never finished, and a newly added job kind is picked up
              // even if older jobs already completed in a past run.
              completedArchiveJobs.add(jobName);
              await this.repo.setMeta(adapter.name, { completedArchiveJobs: [...completedArchiveJobs] });
            },
          },
          { skipJobNames: completedArchiveJobs, isCancelled: () => this.cancelRequested },
        );
        await this.repo.flush();
        if (this.cancelRequested) break; // run didn't finish — don't stamp meta for this adapter
        const stamp: Parameters<TenderRepository['setMeta']>[1] = {
          lastScrapedAt: now(),
          total: this.repo.getSourceCount(adapter.name),
        };
        if (scope === 'all' || scope === 'archive') stamp.lastArchiveBackfillAt = now();
        await this.repo.setMeta(adapter.name, stamp);
      }
      if (!this.cancelRequested) {
        const staleCount = this.repo.reconcileStaleOpen(new Date(now()));
        if (staleCount > 0) await this.repo.flush();
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
