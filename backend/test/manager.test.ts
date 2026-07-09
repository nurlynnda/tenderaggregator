import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TenderPatch } from '@tms/shared';
import type { ScrapeHooks, ScrapeScope, ScraperAdapter } from '../src/scrapers/types.js';
import { TenderRepository } from '../src/storage/repository.js';
import { ScrapeManager } from '../src/scrape/manager.js';

const NOW = () => '2026-07-07T12:00:00.000Z';

function makePatch(id: number): TenderPatch {
  return {
    dedupKey: `REF/${id}`, referenceNo: `REF/${id}`, title: `T${id}`,
    status: 'open', procurementType: 'quotation',
    scrapedAt: NOW(),
    source: { source: 'fake', sourceId: String(id), sourceUrl: `https://example.com/${id}` },
  };
}

function fakeAdapter(
  behavior: (scope: ScrapeScope, hooks: ScrapeHooks, opts?: import('../src/scrapers/types.js').ScrapeOptions) => Promise<void>,
  archiveJobNames: string[] = [],
): ScraperAdapter {
  return { name: 'fake', scrape: behavior, archiveJobNames: () => archiveJobNames };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function freshRepo() {
  const repo = new TenderRepository(mkdtempSync(join(tmpdir(), 'tms-mgr-')));
  await repo.load();
  return repo;
}

describe('ScrapeManager', () => {
  it('starts idle', async () => {
    const mgr = new ScrapeManager([], await freshRepo(), { now: NOW });
    expect(mgr.status()).toEqual({ state: 'idle' });
  });

  it('runs a scrape: merges batches, reports done, stamps lastScrapedAt and total', async () => {
    const repo = await freshRepo();
    const adapter = fakeAdapter(async (_scope, hooks) => {
      hooks.onProgress({ source: 'fake', job: 'open-quotation', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1 });
      await hooks.onBatch([makePatch(1), makePatch(2)]);
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('open');
    expect(mgr.status().state).toBe('done');
    expect(repo.getAll()).toHaveLength(2);
    expect(repo.getMeta('fake').lastScrapedAt).toBe(NOW());
    expect(repo.getMeta('fake').lastArchiveBackfillAt).toBeNull();
    expect(repo.getMeta('fake').total).toBe(2);
  });

  it('stamps lastArchiveBackfillAt when scope covers archive', async () => {
    const repo = await freshRepo();
    const adapter = fakeAdapter(async () => {});
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('all');
    expect(repo.getMeta('fake').lastArchiveBackfillAt).toBe(NOW());
  });

  it('exposes live progress while running', async () => {
    const repo = await freshRepo();
    let capturedMid: unknown;
    const adapter = fakeAdapter(async (_s, hooks) => {
      hooks.onProgress({ source: 'fake', job: 'open-tender', jobsCompleted: 1, jobsTotal: 3, currentPage: 12, lastPage: 96 });
      capturedMid = mgr.status();
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('open');
    expect(capturedMid).toEqual({
      state: 'running', source: 'fake', job: 'open-tender',
      jobsCompleted: 1, jobsTotal: 3, currentPage: 12, lastPage: 96,
    });
  });

  it('rejects concurrent starts', async () => {
    const repo = await freshRepo();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const adapter = fakeAdapter(async () => gate);
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    expect(mgr.start('open')).toBe(true);
    expect(mgr.start('open')).toBe(false); // already running
    release();
    await waitUntil(() => mgr.status().state !== 'running');
    expect(mgr.status().state).toBe('done');
  });

  it('defaults to a small flush interval for open scope and a larger one for archive/all scope', async () => {
    async function countFlushes(scope: ScrapeScope, pages: number): Promise<number> {
      const repo = await freshRepo();
      const originalFlush = repo.flush.bind(repo);
      let flushCount = 0;
      repo.flush = async () => {
        flushCount += 1;
        return originalFlush();
      };
      const adapter = fakeAdapter(async (_s, hooks) => {
        for (let i = 0; i < pages; i += 1) {
          await hooks.onBatch([makePatch(i)]);
        }
      });
      const mgr = new ScrapeManager([adapter], repo, { now: NOW });
      await mgr.runToCompletion(scope);
      return flushCount;
    }
    // 20 pages: open's smaller default interval should flush mid-run more often than
    // archive's larger default interval (trading redo-window size for fewer full rewrites).
    const openFlushes = await countFlushes('open', 20);
    const archiveFlushes = await countFlushes('archive', 20);
    expect(openFlushes).toBeGreaterThan(archiveFlushes);
  });

  it('passes previously-completed archive job names as skipJobNames, and persists onJobDone incrementally', async () => {
    const repo = await freshRepo();
    await repo.setMeta('fake', { completedArchiveJobs: ['closed-quotation'] });
    const seenSkip: Set<string>[] = [];
    const adapter = fakeAdapter(async (_scope, hooks, opts) => {
      seenSkip.push(new Set(opts!.skipJobNames!)); // snapshot: the manager's set mutates as jobs finish
      await hooks.onJobDone!('closed-tender');
      // mid-run: only the job just finished has been persisted so far, alongside the pre-existing one.
      expect(repo.getMeta('fake').completedArchiveJobs).toEqual(['closed-quotation', 'closed-tender']);
      await hooks.onJobDone!('closed-requisition');
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('archive');
    expect(seenSkip[0]).toEqual(new Set(['closed-quotation']));
    expect(repo.getMeta('fake').completedArchiveJobs).toEqual(['closed-quotation', 'closed-tender', 'closed-requisition']);
  });

  it('sets failed state with error message; keeps previously flushed batches', async () => {
    const repo = await freshRepo();
    const adapter = fakeAdapter(async (_s, hooks) => {
      await hooks.onBatch([makePatch(1)]);
      throw new Error('fetch failed after 3 attempts: url');
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW, flushEveryPages: 1 });
    await mgr.runToCompletion('open');
    expect(mgr.status().state).toBe('failed');
    expect(mgr.status().error).toContain('fetch failed');
    expect(repo.getAll()).toHaveLength(1); // flushed page survived
    expect(repo.getMeta('fake').lastScrapedAt).toBeNull(); // not stamped on failure
  });

  it('runs only the named adapter when sourceName is given, leaving other adapters untouched', async () => {
    const repo = await freshRepo();
    const calls: string[] = [];
    const adapterA: ScraperAdapter = { name: 'a', scrape: async () => { calls.push('a'); }, archiveJobNames: () => [] };
    const adapterB: ScraperAdapter = { name: 'b', scrape: async () => { calls.push('b'); }, archiveJobNames: () => [] };
    const mgr = new ScrapeManager([adapterA, adapterB], repo, { now: NOW });
    await mgr.runToCompletion('open', { sourceName: 'b' });
    expect(calls).toEqual(['b']);
  });

  it('listSources reports name, lastScrapedAt, lastArchiveBackfillAt, and total per adapter', async () => {
    const repo = await freshRepo();
    const adapter = fakeAdapter(async (_s, hooks) => { await hooks.onBatch([makePatch(1)]); });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    expect(mgr.listSources()).toEqual([{ name: 'fake', lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 }]);
    await mgr.runToCompletion('open');
    expect(mgr.listSources()).toEqual([{ name: 'fake', lastScrapedAt: NOW(), lastArchiveBackfillAt: null, total: 1 }]);
  });
});
