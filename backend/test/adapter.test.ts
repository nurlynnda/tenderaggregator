import { describe, expect, it, vi } from 'vitest';
import type { TenderPatch } from '@tms/shared';
import { MyProcurementAdapter, MYPROCUREMENT_JOBS } from '../src/scrapers/myprocurement/adapter.js';

// Minimal parseable card generator (same markup shape both parsers understand: identity +
// reference number + title link; no winner table, so results jobs yield winners: []).
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
  it('defines exactly the 8 verified type/category combinations (6 full + 2 results)', () => {
    expect(MYPROCUREMENT_JOBS).toEqual([
      { status: 'open', procurementType: 'quotation', type: 'advertisements', category: 'quotation', kind: 'full' },
      { status: 'open', procurementType: 'tender', type: 'advertisements', category: 'tender', kind: 'full' },
      { status: 'open', procurementType: 'requisition', type: 'advertisements', category: 'requisition', kind: 'full' },
      { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'advertisement-quotation', kind: 'full' },
      { status: 'closed', procurementType: 'tender', type: 'archive', category: 'advertisement-tender', kind: 'full' },
      { status: 'closed', procurementType: 'requisition', type: 'archive', category: 'advertisement-requisition', kind: 'full' },
      { status: 'closed', procurementType: 'quotation', type: 'archive', category: 'results-quotation', kind: 'results' },
      { status: 'closed', procurementType: 'tender', type: 'archive', category: 'results-tender', kind: 'results' },
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
    const batches: TenderPatch[][] = [];
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

  it('scope=archive crawls the 3 archive jobs plus the 2 results jobs (5 total)', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { urls.push(url); return pageResponse([1], 1); });
    const adapter = new MyProcurementAdapter(fetcher);
    await adapter.scrape('archive', { onProgress: () => {}, onBatch: async () => {} });
    expect(urls).toHaveLength(5);
    for (const url of urls) {
      const params = new URL(url).searchParams;
      expect(params.get('type')).toBe('archive');
      expect(params.get('category')).toMatch(/^(advertisement-(quotation|tender|requisition)|results-(quotation|tender))$/);
    }
  });

  it('scope=all runs all 8 jobs and tags status/procurementType per job', async () => {
    const fetcher = vi.fn(async (url: string) => pageResponse([Number(new URL(url).searchParams.get('page'))], 1));
    const adapter = new MyProcurementAdapter(fetcher);
    const all: TenderPatch[] = [];
    await adapter.scrape('all', { onProgress: () => {}, onBatch: async (t) => { all.push(...t); } });
    expect(all.filter((t) => t.status === 'open')).toHaveLength(3);
    expect(all.filter((t) => t.status === 'closed')).toHaveLength(5);
  });

  it('emits winners (possibly empty) only for results jobs, via parseResultsHtml', async () => {
    const fetcher = vi.fn(async () => pageResponse([1], 1));
    const adapter = new MyProcurementAdapter(fetcher);
    const batchesByJob: TenderPatch[][] = [];
    await adapter.scrape('archive', { onProgress: () => {}, onBatch: async (t) => { batchesByJob.push(t); } });
    // Jobs run in MYPROCUREMENT_JOBS order filtered to closed: 3 full archive jobs, then 2 results jobs.
    const resultsBatches = batchesByJob.slice(3);
    expect(resultsBatches).toHaveLength(2);
    for (const batch of resultsBatches) {
      for (const patch of batch) {
        expect(patch.winners).toEqual([]); // no winner table in this fixture's card markup
        expect(patch.fieldCodes).toBeUndefined(); // results patches never observe field codes
      }
    }
  });

  it('reports progress with job name, page counts and job totals', async () => {
    const fetcher = vi.fn(async () => pageResponse([1], 2));
    const adapter = new MyProcurementAdapter(fetcher);
    const progress: unknown[] = [];
    await adapter.scrape('archive', { onProgress: (p) => progress.push({ ...p }), onBatch: async () => {} });
    expect(progress[0]).toEqual({
      source: 'myprocurement', job: 'closed-quotation',
      jobsCompleted: 0, jobsTotal: 5, currentPage: 1, lastPage: 2,
    });
  });

  it('names results jobs distinctly (job name suffix)', async () => {
    const fetcher = vi.fn(async () => pageResponse([1], 1));
    const adapter = new MyProcurementAdapter(fetcher);
    const jobNames: string[] = [];
    await adapter.scrape('archive', { onProgress: (p) => jobNames.push(p.job), onBatch: async () => {} });
    expect(jobNames).toEqual([
      'closed-quotation', 'closed-tender', 'closed-requisition',
      'closed-quotation-results', 'closed-tender-results',
    ]);
  });

  it('rejects when the fetcher exhausts retries, without calling onBatch for the failed page', async () => {
    const fetcher = vi.fn(async () => { throw new Error('fetch failed after 3 attempts: x'); });
    const adapter = new MyProcurementAdapter(fetcher);
    const onBatch = vi.fn(async () => {});
    await expect(adapter.scrape('open', { onProgress: () => {}, onBatch })).rejects.toThrow('fetch failed');
    expect(onBatch).not.toHaveBeenCalled();
  });
});
