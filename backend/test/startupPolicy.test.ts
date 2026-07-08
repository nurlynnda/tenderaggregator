import { describe, expect, it } from 'vitest';
import { decideStartupPolicy } from '../src/startupPolicy.js';

const ARCHIVE_JOBS = ['closed-quotation', 'closed-tender', 'closed-requisition'];

describe('decideStartupPolicy', () => {
  it('needs a full scrape when no adapter has ever run', () => {
    const result = decideStartupPolicy({
      adapterNames: ['myprocurement'],
      hasSource: () => false,
      mergedCount: 0,
      getArchiveJobNames: () => ARCHIVE_JOBS,
      getCompletedArchiveJobs: () => [],
    });
    expect(result.needsFull).toBe(true);
    expect(result.emptyStoreMismatch).toBe(false); // no source ever ran, so nothing to mismatch
  });

  it('forces a full rescrape when the merged store is empty despite a source reporting prior completion (the bug)', () => {
    // Reproduces stale/partial data dir: myprocurement/meta.json exists with a completed
    // archive backfill, but the top-level tenders.json is missing/empty (e.g. migrated from
    // the old per-source layout, or corrupted). Previously this silently short-circuited to
    // "nothing to do", serving 0 tenders forever.
    const result = decideStartupPolicy({
      adapterNames: ['myprocurement'],
      hasSource: (name) => name === 'myprocurement',
      mergedCount: 0,
      getArchiveJobNames: () => ARCHIVE_JOBS,
      getCompletedArchiveJobs: () => ARCHIVE_JOBS,
    });
    expect(result.needsFull).toBe(true);
    expect(result.emptyStoreMismatch).toBe(true);
  });

  it('does not need a full scrape or backfill when the merged store is populated and every archive job has completed', () => {
    const result = decideStartupPolicy({
      adapterNames: ['myprocurement'],
      hasSource: (name) => name === 'myprocurement',
      mergedCount: 42,
      getArchiveJobNames: () => ARCHIVE_JOBS,
      getCompletedArchiveJobs: () => ARCHIVE_JOBS,
    });
    expect(result.needsFull).toBe(false);
    expect(result.needsBackfill).toBe(false);
    expect(result.emptyStoreMismatch).toBe(false);
  });

  it('needs only a backfill resume when data exists but no archive job has completed yet', () => {
    const result = decideStartupPolicy({
      adapterNames: ['myprocurement'],
      hasSource: (name) => name === 'myprocurement',
      mergedCount: 10,
      getArchiveJobNames: () => ARCHIVE_JOBS,
      getCompletedArchiveJobs: () => [],
    });
    expect(result.needsFull).toBe(false);
    expect(result.needsBackfill).toBe(true);
    expect(result.emptyStoreMismatch).toBe(false);
  });

  it('needs a backfill resume when a NEW archive job kind was added after a prior backfill already completed (the gap this fixes)', () => {
    // Reproduces the reported bug: results-quotation/results-tender were added to the adapter's
    // job list after the original 3 archive jobs had already completed and been stamped. A
    // single completion flag would treat the source as "done forever"; per-job tracking
    // correctly notices the 2 new job names are missing from completedArchiveJobs.
    const result = decideStartupPolicy({
      adapterNames: ['myprocurement'],
      hasSource: (name) => name === 'myprocurement',
      mergedCount: 84773,
      getArchiveJobNames: () => [...ARCHIVE_JOBS, 'closed-quotation-results', 'closed-tender-results'],
      getCompletedArchiveJobs: () => ARCHIVE_JOBS, // only the 3 original jobs were ever completed
    });
    expect(result.needsFull).toBe(false);
    expect(result.needsBackfill).toBe(true);
    expect(result.emptyStoreMismatch).toBe(false);
  });
});
