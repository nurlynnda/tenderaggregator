import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Tender } from '@tms/shared';
import type { ScrapeHooks, ScrapeScope, ScraperAdapter } from '../src/scrapers/types.js';
import { TenderRepository } from '../src/storage/repository.js';
import { ScrapeManager } from '../src/scrape/manager.js';

const NOW = () => '2026-07-07T12:00:00.000Z';

function makeTender(id: number): Tender {
  return {
    id: `fake:${id}`, source: 'fake', sourceId: String(id),
    referenceNo: `REF/${id}`, dedupKey: `REF/${id}`, title: `T${id}`,
    sourceUrl: `https://example.com/${id}`, status: 'open', procurementType: 'quotation',
    ministry: null, agency: null, category: null, fieldCodes: [],
    advertisedDate: null, closingDate: null, indicativePrice: null,
    currency: 'MYR', events: [], raw: {}, scrapedAt: NOW(),
  };
}

function fakeAdapter(behavior: (scope: ScrapeScope, hooks: ScrapeHooks) => Promise<void>): ScraperAdapter {
  return { name: 'fake', scrape: behavior };
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

  it('runs a scrape: upserts batches, reports done, stamps lastScrapedAt', async () => {
    const repo = await freshRepo();
    const adapter = fakeAdapter(async (_scope, hooks) => {
      hooks.onProgress({ source: 'fake', job: 'open-quotation', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1 });
      await hooks.onBatch([makeTender(1), makeTender(2)]);
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('open');
    expect(mgr.status().state).toBe('done');
    expect(repo.getAll()).toHaveLength(2);
    expect(repo.getMeta('fake').lastScrapedAt).toBe(NOW());
    expect(repo.getMeta('fake').lastArchiveBackfillAt).toBeNull();
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

  it('sets failed state with error message; keeps previously flushed batches', async () => {
    const repo = await freshRepo();
    const adapter = fakeAdapter(async (_s, hooks) => {
      await hooks.onBatch([makeTender(1)]);
      throw new Error('fetch failed after 3 attempts: url');
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW, flushEveryPages: 1 });
    await mgr.runToCompletion('open');
    expect(mgr.status().state).toBe('failed');
    expect(mgr.status().error).toContain('fetch failed');
    expect(repo.getAll()).toHaveLength(1); // flushed page survived
    expect(repo.getMeta('fake').lastScrapedAt).toBeNull(); // not stamped on failure
  });
});
