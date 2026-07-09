// Pure decision logic for the startup scrape policy (see index.ts's `main()`), extracted so
// it can be unit-tested directly — index.ts itself is process-bootstrap code excluded from
// the coverage gate (see vitest.config.ts).
//
// Called ONCE PER ADAPTER (not once for the whole app): a brand-new adapter must always get
// its own full scrape at startup, regardless of what any other already-bootstrapped adapter
// has done. See docs/superpowers/specs/2026-07-10-scrape-settings-page-design.md.

export interface StartupPolicyDeps {
  /** Whether THIS adapter has ever completed any scrape (has a meta.json entry). */
  hasSource: boolean;
  /** Whether the whole merged tender store is empty — a fact shared across every adapter. */
  mergedIsEmpty: boolean;
  /** This adapter's own full set of closed/archive job names (ScraperAdapter.archiveJobNames). */
  archiveJobNames: string[];
  /** This adapter's own archive job names that have fully paginated at least once. */
  completedArchiveJobs: string[];
}

export interface StartupPolicyResult {
  needsFull: boolean;
  needsBackfill: boolean;
  // true when this adapter's meta claims prior completion, yet the merged store is empty —
  // e.g. stale/partial data dir. Surfaced so callers can log a warning instead of self-healing
  // silently.
  emptyStoreMismatch: boolean;
}

export function decideStartupPolicy(deps: StartupPolicyDeps): StartupPolicyResult {
  const needsFull = !deps.hasSource || deps.mergedIsEmpty;
  const completed = new Set(deps.completedArchiveJobs);
  const needsBackfill = deps.archiveJobNames.some((job) => !completed.has(job));
  const emptyStoreMismatch = deps.mergedIsEmpty && deps.hasSource;
  return { needsFull, needsBackfill, emptyStoreMismatch };
}
