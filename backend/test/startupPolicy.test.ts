import { describe, expect, it } from 'vitest';
import { decideStartupPolicy } from '../src/startupPolicy.js';

describe('decideStartupPolicy', () => {
  it('needs a full scrape when no adapter has ever run', () => {
    const result = decideStartupPolicy({
      adapterNames: ['myprocurement'],
      hasSource: () => false,
      mergedCount: 0,
      getLastArchiveBackfillAt: () => null,
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
      getLastArchiveBackfillAt: () => '2026-01-01T00:00:00.000Z',
    });
    expect(result.needsFull).toBe(true);
    expect(result.emptyStoreMismatch).toBe(true);
  });

  it('does not need a full scrape when the merged store is populated and a source has run', () => {
    const result = decideStartupPolicy({
      adapterNames: ['myprocurement'],
      hasSource: (name) => name === 'myprocurement',
      mergedCount: 42,
      getLastArchiveBackfillAt: () => '2026-01-01T00:00:00.000Z',
    });
    expect(result.needsFull).toBe(false);
    expect(result.needsBackfill).toBe(false);
    expect(result.emptyStoreMismatch).toBe(false);
  });

  it('needs only a backfill resume when data exists but archive backfill is unset', () => {
    const result = decideStartupPolicy({
      adapterNames: ['myprocurement'],
      hasSource: (name) => name === 'myprocurement',
      mergedCount: 10,
      getLastArchiveBackfillAt: () => null,
    });
    expect(result.needsFull).toBe(false);
    expect(result.needsBackfill).toBe(true);
    expect(result.emptyStoreMismatch).toBe(false);
  });
});
