import { describe, expect, it, vi } from 'vitest';
import type { Tender } from '@tms/shared';
import { MyProcurementAdapter, MYPROCUREMENT_JOBS } from '../src/scrapers/myprocurement/adapter.js';

// Minimal parseable card generator (same markup shape the parser understands).
function cardHtml(id: number, ref: string): string {
  return `<div x-data="{ selected: false, open: true }">
    <button x-on:click="$dispatch('select-procurement', { id: ${id} })"></button>
    <div class="px-4 py-2"><span class="font-bold">No. Sebut Harga</span>: ${ref}</div>
    <div class="font-bold text-primary"><a href="https://myprocurement.treasury.gov.my/advertisements/quotation/h${id}">TITLE ${id}</a></div>
  </div>`;
}

function pageResponse(ids: number[], lastPage: number) {
  return { html: `<div>${ids.map((i) => cardHtml(i, `REF/${i}`)).join('')}</div>`, total: ids.length, page: 1, lastPage };
}

describe('MYPROCUREMENT_JOBS', () => {
  it('defines exactly the 6 verified type/category combinations', () => {
    expect(MYPROCUREMENT_JOBS).toEqual([
      { status: 'open', procurementType: 'quotation', type: 'advertisements', category: 'quotation' },
      { status: 'open', procurementType: 'tender', type: 'advertisements', category: 'tender' },
      { status: 'open', procurementType: 'requisition', type: 'advertisements', category: 'requisition' },
      { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'advertisement-quotation' },
      { status: 'closed', procurementType: 'tender', type: 'archive', category: 'advertisement-tender' },
      { status: 'closed', procurementType: 'requisition', type: 'archive', category: 'advertisement-requisition' },
    ]);
  });
});

describe('MyProcurementAdapter', () => {
  it('scope=open crawls only the 3 advertisement jobs, every page, with explicit params', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      return pageResponse([page * 10 + 1], 2); // 2 pages per job
    });
    const adapter = new MyProcurementAdapter(fetcher);
    const batches: Tender[][] = [];
    await adapter.scrape('open', { onProgress: () => {}, onBatch: async (t) => { batches.push(t); } });

    expect(urls).toHaveLength(6); // 3 jobs x 2 pages
    for (const url of urls) {
      const params = new URL(url).searchParams;
      expect(params.get('itemsPerPage')).toBe('100');
      expect(params.get('type')).toBe('advertisements');
      expect(['quotation', 'tender', 'requisition']).toContain(params.get('category'));
    }
    expect(batches).toHaveLength(6);
    expect(batches.flat().every((t) => t.status === 'open')).toBe(true);
  });

  it('scope=archive crawls the 3 archive jobs with advertisement-* categories', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { urls.push(url); return pageResponse([1], 1); });
    const adapter = new MyProcurementAdapter(fetcher);
    await adapter.scrape('archive', { onProgress: () => {}, onBatch: async () => {} });
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      const params = new URL(url).searchParams;
      expect(params.get('type')).toBe('archive');
      expect(params.get('category')).toMatch(/^advertisement-(quotation|tender|requisition)$/);
    }
  });

  it('scope=all runs all 6 jobs and tags status/procurementType per job', async () => {
    const fetcher = vi.fn(async (url: string) => pageResponse([Number(new URL(url).searchParams.get('page'))], 1));
    const adapter = new MyProcurementAdapter(fetcher);
    const all: Tender[] = [];
    await adapter.scrape('all', { onProgress: () => {}, onBatch: async (t) => { all.push(...t); } });
    expect(all.filter((t) => t.status === 'open')).toHaveLength(3);
    expect(all.filter((t) => t.status === 'closed')).toHaveLength(3);
  });

  it('reports progress with job name, page counts and job totals', async () => {
    const fetcher = vi.fn(async () => pageResponse([1], 2));
    const adapter = new MyProcurementAdapter(fetcher);
    const progress: unknown[] = [];
    await adapter.scrape('archive', { onProgress: (p) => progress.push({ ...p }), onBatch: async () => {} });
    expect(progress[0]).toEqual({
      source: 'myprocurement', job: 'closed-quotation',
      jobsCompleted: 0, jobsTotal: 3, currentPage: 1, lastPage: 2,
    });
  });

  it('rejects when the fetcher exhausts retries, without calling onBatch for the failed page', async () => {
    const fetcher = vi.fn(async () => { throw new Error('fetch failed after 3 attempts: x'); });
    const adapter = new MyProcurementAdapter(fetcher);
    const onBatch = vi.fn(async () => {});
    await expect(adapter.scrape('open', { onProgress: () => {}, onBatch })).rejects.toThrow('fetch failed');
    expect(onBatch).not.toHaveBeenCalled();
  });
});
