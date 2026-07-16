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

function resultsPage(rows: Array<{ id: number; contractor: string; nilai: string }>): string {
  const trs = rows
    .map(
      (r) => `<tr>
        <td><a href="https://www.llm.gov.my/swasta/tender_detail/${r.id}#tender-table-head"><header>TITLE ${r.id}</header></a></td>
        <td style="font-weight: bold;">${r.contractor}</td>
        <td style="font-weight: bold;">${r.nilai}</td>
      </tr>`,
    )
    .join('');
  return `<div id="tender-table-head"><table><tbody>${trs}</tbody></table></div>`;
}

describe('LlmAdapter — job model', () => {
  it('reports "closed" as both its archive job and its results job — Keputusan carries award data', () => {
    const adapter = new LlmAdapter(vi.fn(), NOW);
    expect(adapter.archiveJobNames()).toEqual(['closed']);
    expect(adapter.resultsJobNames()).toEqual(['closed']);
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

  it('scope=all runs both the open listing job and the closed/results job', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === 'https://www.llm.gov.my/swasta/tender_tawaran/') return listingPage([1]);
      if (url === 'https://www.llm.gov.my/swasta/tender_tawaran/6') return listingPage([]);
      if (url === 'https://www.llm.gov.my/swasta/tender_keputusan/') {
        return resultsPage([{ id: 2, contractor: 'ACME SDN BHD', nilai: 'RM 100.00' }]);
      }
      if (url === 'https://www.llm.gov.my/swasta/tender_keputusan/6') return resultsPage([]);
      return detailPage(Number(url.match(/tender_detail\/(\d+)/)![1]));
    });
    const adapter = new LlmAdapter(fetcher, NOW);
    const batches: TenderPatch[][] = [];
    const done: string[] = [];
    await adapter.scrape('all', {
      onProgress: () => {},
      onBatch: async (t) => { batches.push(t); },
      onJobDone: (name) => done.push(name),
    });
    expect(done).toEqual(['open', 'closed']);
    expect(batches).toHaveLength(2);
    expect(batches[0]![0]!.status).toBe('open');
    expect(batches[1]![0]!.status).toBe('closed');
    expect(batches[1]![0]!.winners).toEqual([{ name: 'ACME SDN BHD', price: 100 }]);
  });

  it('scope=open never fetches the closed/results listing', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/tender_tawaran/')) return listingPage([1]);
      return detailPage(1);
    });
    const adapter = new LlmAdapter(fetcher, NOW);
    await adapter.scrape('open', { onProgress: () => {}, onBatch: async () => {} });
    expect(fetcher).not.toHaveBeenCalledWith(expect.stringContaining('tender_keputusan'));
  });

  it('scope=archive fetches only the closed/results listing, marking tenders closed with their winner', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/tender_keputusan/')) {
        return resultsPage([{ id: 5, contractor: 'BETA SDN BHD', nilai: 'RM 999.50' }]);
      }
      if (url.match(/tender_keputusan\/\d+$/)) return resultsPage([]);
      return detailPage(5);
    });
    const adapter = new LlmAdapter(fetcher, NOW);
    const batches: TenderPatch[][] = [];
    await adapter.scrape('archive', { onProgress: () => {}, onBatch: async (t) => { batches.push(t); } });

    expect(fetcher).not.toHaveBeenCalledWith(expect.stringContaining('tender_tawaran'));
    expect(batches).toHaveLength(1);
    expect(batches[0]![0]!.status).toBe('closed');
    expect(batches[0]![0]!.winners).toEqual([{ name: 'BETA SDN BHD', price: 999.5 }]);
  });

  it('never requests a second page of the closed/results listing — llm.gov.my 404s its own offset pagination there', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith('/tender_keputusan/')) {
        return resultsPage([{ id: 5, contractor: 'BETA SDN BHD', nilai: 'RM 999.50' }]);
      }
      return detailPage(5);
    });
    const adapter = new LlmAdapter(fetcher, NOW);
    await adapter.scrape('archive', { onProgress: () => {}, onBatch: async () => {} });

    expect(urls).toContain('https://www.llm.gov.my/swasta/tender_keputusan/');
    expect(urls).not.toContain('https://www.llm.gov.my/swasta/tender_keputusan/6');
  });

  it('records winners: null for a closed tender whose results row has no contractor yet', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/tender_keputusan/')) return resultsPage([{ id: 5, contractor: '', nilai: '' }]);
      if (url.match(/tender_keputusan\/\d+$/)) return resultsPage([]);
      return detailPage(5);
    });
    const adapter = new LlmAdapter(fetcher, NOW);
    const batches: TenderPatch[][] = [];
    await adapter.scrape('archive', { onProgress: () => {}, onBatch: async (t) => { batches.push(t); } });
    expect(batches[0]![0]!.winners).toBeNull();
  });

  it('skips the closed job entirely when it is already in skipJobNames', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/tender_tawaran/')) return listingPage([1]);
      return detailPage(1);
    });
    const adapter = new LlmAdapter(fetcher, NOW);
    await adapter.scrape('all', { onProgress: () => {}, onBatch: async () => {} }, {
      skipJobNames: new Set(['closed']),
    });
    expect(fetcher).not.toHaveBeenCalledWith(expect.stringContaining('tender_keputusan'));
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
