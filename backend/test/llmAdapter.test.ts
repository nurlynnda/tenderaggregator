import { describe, expect, it, vi } from 'vitest';
import type { TenderPatch } from '@tms/shared';
import { LlmAdapter } from '../src/scrapers/llm/adapter.js';

const NOW = () => '2026-07-16T00:00:00.000Z';

function listingPage(ids: number[]): string {
  const rows = ids
    .map(
      (id) => `<tr><td><a href="https://www.llm.gov.my/swasta/tender_detail/${id}/#tender-table-head">
        <header>TITLE ${id}</header></a></td><td>20/07/2026</td><td>14/09/2026</td><td>14/10/2026</td></tr>`,
    )
    .join('');
  return `<div id="tender-table-head"><table><tbody>${rows}</tbody></table></div>`;
}

function detailPage(id: number): string {
  return `<div id="tender-table-head"><div class="panel-content"><header>TITLE ${id}</header>
    <table class="tender-content"><tbody>
      <tr><td style="font-weight: bold;">Tarikh Mula Jualan Dokumen</td><td>20.07.2026</td></tr>
      <tr><td style="font-weight: bold;">Jenis</td><td>Tender</td></tr>
      <tr><td style="font-weight: bold;">Kategori</td><td>Kerja</td></tr>
      <tr><td style="font-weight: bold;">Tarikh dan Waktu Tutup</td><td>2026-10-14</td></tr>
    </tbody></table>
  </div></div>`;
}

describe('LlmAdapter — job model', () => {
  it('has no archive/results job names — this source only ever has an open listing', () => {
    const adapter = new LlmAdapter(vi.fn(), NOW);
    expect(adapter.archiveJobNames()).toEqual([]);
    expect(adapter.resultsJobNames()).toEqual([]);
  });

  it('scope=archive is a no-op — never fetches anything', async () => {
    const fetcher = vi.fn();
    const adapter = new LlmAdapter(fetcher, NOW);
    await adapter.scrape('archive', { onProgress: () => {}, onBatch: async () => {} });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('paginates the listing by offsets of 6 until a page comes back with zero tenders', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      urls.push(url);
      if (url === 'https://www.llm.gov.my/swasta/tender_tawaran/') return listingPage([1, 2]);
      if (url === 'https://www.llm.gov.my/swasta/tender_tawaran/6') return listingPage([3]);
      if (url === 'https://www.llm.gov.my/swasta/tender_tawaran/12') return listingPage([]);
      return detailPage(1);
    });
    const adapter = new LlmAdapter(fetcher, NOW);
    await adapter.scrape('open', { onProgress: () => {}, onBatch: async () => {} });

    expect(urls).toEqual([
      'https://www.llm.gov.my/swasta/tender_tawaran/',
      'https://www.llm.gov.my/swasta/tender_tawaran/6',
      'https://www.llm.gov.my/swasta/tender_tawaran/12',
      'https://www.llm.gov.my/swasta/tender_detail/1/',
      'https://www.llm.gov.my/swasta/tender_detail/2/',
      'https://www.llm.gov.my/swasta/tender_detail/3/',
    ]);
  });

  it('fetches the detail page for every listed tender and emits one batch per tender', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === 'https://www.llm.gov.my/swasta/tender_tawaran/') return listingPage([1, 2]);
      if (url === 'https://www.llm.gov.my/swasta/tender_tawaran/6') return listingPage([]);
      const m = url.match(/tender_detail\/(\d+)\//);
      return detailPage(Number(m![1]));
    });
    const adapter = new LlmAdapter(fetcher, NOW);
    const batches: TenderPatch[][] = [];
    await adapter.scrape('open', { onProgress: () => {}, onBatch: async (t) => { batches.push(t); } });

    expect(batches).toHaveLength(2);
    expect(batches[0]![0]!.source.sourceId).toBe('1');
    expect(batches[1]![0]!.source.sourceId).toBe('2');
    expect(batches[0]![0]!.status).toBe('open');
  });

  it('treats scope=all the same as scope=open (there is no archive job to add)', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/tender_tawaran/')) return listingPage([1]);
      return detailPage(1);
    });
    const adapter = new LlmAdapter(fetcher, NOW);
    const batches: TenderPatch[][] = [];
    await adapter.scrape('all', { onProgress: () => {}, onBatch: async (t) => { batches.push(t); } });
    expect(batches).toHaveLength(1);
  });

  it('rejects when the listing fetcher fails, without calling onBatch', async () => {
    const fetcher = vi.fn(async () => { throw new Error('fetch failed after 3 attempts: x'); });
    const adapter = new LlmAdapter(fetcher, NOW);
    const onBatch = vi.fn(async () => {});
    await expect(adapter.scrape('open', { onProgress: () => {}, onBatch })).rejects.toThrow('fetch failed');
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('skips a tender whose detail fetch fails, without aborting the job', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/tender_tawaran/')) return listingPage([1, 2]);
      if (url === 'https://www.llm.gov.my/swasta/tender_detail/1/') throw new Error('timeout');
      return detailPage(2);
    });
    const adapter = new LlmAdapter(fetcher, NOW);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const batches: TenderPatch[][] = [];
    const done: string[] = [];
    await adapter.scrape('open', {
      onProgress: () => {},
      onBatch: async (t) => { batches.push(t); },
      onJobDone: (name) => done.push(name),
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]![0]!.source.sourceId).toBe('2');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tender_detail/1/'));
    expect(done).toEqual(['open']);
    warnSpy.mockRestore();
  });

  it('stops before the next detail fetch when isCancelled reports true, without throwing', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === 'https://www.llm.gov.my/swasta/tender_tawaran/') return listingPage([1, 2]);
      if (url === 'https://www.llm.gov.my/swasta/tender_tawaran/6') return listingPage([]);
      return detailPage(1);
    });
    const adapter = new LlmAdapter(fetcher, NOW);
    let cancel = false;
    const batches: TenderPatch[][] = [];
    await adapter.scrape('open', {
      onProgress: () => {},
      onBatch: async (t) => { batches.push(t); cancel = true; },
    }, { isCancelled: () => cancel });

    expect(batches).toHaveLength(1);
    // 2 listing-page fetches (page 1, then the empty page confirming the end) + 1 detail fetch
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('stops before fetching the listing at all when isCancelled is already true', async () => {
    const fetcher = vi.fn();
    const adapter = new LlmAdapter(fetcher, NOW);
    await adapter.scrape('open', { onProgress: () => {}, onBatch: async () => {} }, { isCancelled: () => true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('calls onJobDone with "open" once the job finishes, and reports progress', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/tender_tawaran/')) return listingPage([1]);
      return detailPage(1);
    });
    const adapter = new LlmAdapter(fetcher, NOW);
    const done: string[] = [];
    const progress: unknown[] = [];
    await adapter.scrape('open', {
      onProgress: (p) => progress.push({ ...p }),
      onBatch: async () => {},
      onJobDone: (name) => done.push(name),
    });
    expect(done).toEqual(['open']);
    expect(progress).toContainEqual({
      source: 'llm', job: 'open', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1,
    });
  });
});
