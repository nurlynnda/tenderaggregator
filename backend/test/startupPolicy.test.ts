import { describe, expect, it } from 'vitest';
import { decideStartupPolicy } from '../src/startupPolicy.js';

const ARCHIVE_JOBS = ['closed-quotation', 'closed-tender', 'closed-requisition'];

describe('decideStartupPolicy', () => {
  it('needs a full scrape when this adapter has never run', () => {
    const result = decideStartupPolicy({
      hasSource: false,
      mergedIsEmpty: true,
      archiveJobNames: ARCHIVE_JOBS,
      completedArchiveJobs: [],
    });
    expect(result.needsFull).toBe(true);
    expect(result.emptyStoreMismatch).toBe(false); // never ran, so nothing to mismatch
  });

  it('forces a full rescrape when the merged store is empty despite this adapter reporting prior completion (the original bug)', () => {
    const result = decideStartupPolicy({
      hasSource: true,
      mergedIsEmpty: true,
      archiveJobNames: ARCHIVE_JOBS,
      completedArchiveJobs: ARCHIVE_JOBS,
    });
    expect(result.needsFull).toBe(true);
    expect(result.emptyStoreMismatch).toBe(true);
  });

  it('does not need a full scrape or backfill when this adapter has run and every archive job has completed', () => {
    const result = decideStartupPolicy({
      hasSource: true,
      mergedIsEmpty: false,
      archiveJobNames: ARCHIVE_JOBS,
      completedArchiveJobs: ARCHIVE_JOBS,
    });
    expect(result.needsFull).toBe(false);
    expect(result.needsBackfill).toBe(false);
    expect(result.emptyStoreMismatch).toBe(false);
  });

  it('needs only a backfill resume when this adapter has data but no archive job has completed yet', () => {
    const result = decideStartupPolicy({
      hasSource: true,
      mergedIsEmpty: false,
      archiveJobNames: ARCHIVE_JOBS,
      completedArchiveJobs: [],
    });
    expect(result.needsFull).toBe(false);
    expect(result.needsBackfill).toBe(true);
    expect(result.emptyStoreMismatch).toBe(false);
  });

  it('needs a backfill resume when a NEW archive job kind was added after a prior backfill already completed', () => {
    const result = decideStartupPolicy({
      hasSource: true,
      mergedIsEmpty: false,
      archiveJobNames: [...ARCHIVE_JOBS, 'closed-quotation-results', 'closed-tender-results'],
      completedArchiveJobs: ARCHIVE_JOBS,
    });
    expect(result.needsFull).toBe(false);
    expect(result.needsBackfill).toBe(true);
    expect(result.emptyStoreMismatch).toBe(false);
  });

  it('a brand-new adapter needs a full scrape even when the merged store is non-empty because another adapter already has data (the startup bug this fixes)', () => {
    // Reproduces the real bug: e.g. myprocurement already has data (mergedIsEmpty=false),
    // but a newly added adapter (e.g. span) has never run itself (hasSource=false). It must
    // still get needsFull=true, independent of any other adapter's state.
    const result = decideStartupPolicy({
      hasSource: false,
      mergedIsEmpty: false,
      archiveJobNames: ['closed-2025', 'closed-2024'],
      completedArchiveJobs: [],
    });
    expect(result.needsFull).toBe(true);
  });
});
