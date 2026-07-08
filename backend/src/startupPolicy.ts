// Pure decision logic for the startup scrape policy (see index.ts's `main()`), extracted so
// it can be unit-tested directly — index.ts itself is process-bootstrap code excluded from
// the coverage gate (see vitest.config.ts).

export interface StartupPolicyDeps {
  adapterNames: string[];
  hasSource: (name: string) => boolean;
  mergedCount: number;
  /** The full set of closed/archive job names this adapter will ever run (ScraperAdapter.archiveJobNames). */
  getArchiveJobNames: (name: string) => string[];
  /** Archive job names that have fully paginated at least once (SourceMeta.completedArchiveJobs). */
  getCompletedArchiveJobs: (name: string) => string[];
}

export interface StartupPolicyResult {
  needsFull: boolean;
  needsBackfill: boolean;
  // true when some adapter's per-source meta claims prior completion, yet the merged store
  // is empty — e.g. stale/partial data dir migrated from the old per-source layout, where
  // meta.json exists but the new top-level tenders.json was never written. Surfaced so
  // callers can log a warning instead of self-healing silently.
  emptyStoreMismatch: boolean;
}

export function decideStartupPolicy(deps: StartupPolicyDeps): StartupPolicyResult {
  const mergedIsEmpty = deps.mergedCount === 0;
  const noSourceHasEverRun = deps.adapterNames.every((name) => !deps.hasSource(name));
  const someSourceReportsPrior = deps.adapterNames.some((name) => deps.hasSource(name));

  const needsFull = noSourceHasEverRun || mergedIsEmpty;
  // Per-job-kind comparison (not a single "backfill done" flag): if the adapter has ever grown a
  // new archive job (e.g. a results scraper added after the first backfill completed), that job
  // name won't be in completedArchiveJobs yet, so this correctly reports "needs backfill" instead
  // of treating the whole source as permanently done.
  const needsBackfill = deps.adapterNames.some((name) => {
    const completed = new Set(deps.getCompletedArchiveJobs(name));
    return deps.getArchiveJobNames(name).some((job) => !completed.has(job));
  });
  const emptyStoreMismatch = mergedIsEmpty && someSourceReportsPrior;

  return { needsFull, needsBackfill, emptyStoreMismatch };
}
