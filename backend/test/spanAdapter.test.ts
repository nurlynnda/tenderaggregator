import { describe, expect, it, vi } from 'vitest';
import type { TenderPatch } from '@tms/shared';
import { SpanAdapter } from '../src/scrapers/span/adapter.js';

const FIXED_NOW = () => new Date('2026-07-09T00:00:00.000Z').getTime(); // current year: 2026
const MIN_YEAR = 2017;
const CURRENT_YEAR = 2026;

function pageHtml(id: number, ref: string, badge = 'Diiklankan'): string {
  return `<div class="table-listing">
    <a href="https://www.span.gov.my/tender/view/${id}">
      <h3>${ref}</h3>
      SOME TITLE SECARA TENDER TERBUKA<br>
      Tarikh Iklan 2026-01-01<br>
      Tarikh Tutup 2026-01-15 12:00PM<br>
      Maklumat Sebutharga: <span class="badge">${badge}</span>
    </a>
  </div>`;
}

describe('SpanAdapter — job model', () => {
  it('builds one closed job per year from 2017 up to (but not including) the current year', () => {
    const adapter = new SpanAdapter(vi.fn(), FIXED_NOW);
    expect(adapter.archiveJobNames()).toEqual(
      Array.from({ length: CURRENT_YEAR - MIN_YEAR }, (_, i) => `closed-${CURRENT_YEAR - 1 - i}`),
    );
  });

  it('reports no results jobs — winners are fetched inline as part of each closed-year job, not a separate job', () => {
    const adapter = new SpanAdapter(vi.fn(), FIXED_NOW);
    expect(adapter.resultsJobNames()).toEqual([]);
  });

  it('scope=open fetches only the current year, at /tender/<year>', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { urls.push(url); return pageHtml(1, 'REF/1'); });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    const batches: TenderPatch[][] = [];
    await adapter.scrape('open', { onProgress: () => {}, onBatch: async (t) => { batches.push(t); } });
    expect(urls).toEqual(['https://www.span.gov.my/tender/2026']);
    expect(batches).toHaveLength(1);
    expect(batches[0]![0]!.status).toBe('open');
  });

  it('scope=archive fetches every year except the current one', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { urls.push(url); return pageHtml(1, 'REF/1'); });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    await adapter.scrape('archive', { onProgress: () => {}, onBatch: async () => {} });
    expect(urls).toEqual(
      Array.from({ length: CURRENT_YEAR - MIN_YEAR }, (_, i) => `https://www.span.gov.my/tender/${CURRENT_YEAR - 1 - i}`),
    );
  });

  it('scope=all fetches every year, current year first', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { urls.push(url); return pageHtml(1, 'REF/1'); });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    await adapter.scrape('all', { onProgress: () => {}, onBatch: async () => {} });
    expect(urls[0]).toBe('https://www.span.gov.my/tender/2026');
    expect(urls).toHaveLength(CURRENT_YEAR - MIN_YEAR + 1);
  });

  it('skips closed jobs already present in skipJobNames, but never skips the open job', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { urls.push(url); return pageHtml(1, 'REF/1'); });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    await adapter.scrape('all', { onProgress: () => {}, onBatch: async () => {} }, {
      skipJobNames: new Set(['closed-2025', 'closed-2024']),
    });
    expect(urls).not.toContain('https://www.span.gov.my/tender/2025');
    expect(urls).not.toContain('https://www.span.gov.my/tender/2024');
    expect(urls).toContain('https://www.span.gov.my/tender/2026');
    expect(urls).toContain('https://www.span.gov.my/tender/2023');
  });

  it('calls onJobDone with each job name once it finishes, and reports progress', async () => {
    const fetcher = vi.fn(async () => pageHtml(1, 'REF/1'));
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    const done: string[] = [];
    const progress: unknown[] = [];
    await adapter.scrape('open', {
      onProgress: (p) => progress.push({ ...p }),
      onBatch: async () => {},
      onJobDone: (name) => done.push(name),
    });
    expect(done).toEqual(['open-2026']);
    expect(progress[0]).toEqual({
      source: 'span', job: 'open-2026', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1,
    });
  });

  it('rejects when the fetcher fails, without calling onBatch', async () => {
    const fetcher = vi.fn(async () => { throw new Error('fetch failed after 3 attempts: x'); });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    const onBatch = vi.fn(async () => {});
    await expect(adapter.scrape('open', { onProgress: () => {}, onBatch })).rejects.toThrow('fetch failed');
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('stops before the next year job when isCancelled reports true, without throwing', async () => {
    const fetcher = vi.fn(async () => pageHtml(1, 'REF/1'));
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    let cancelAfterFirst = false;
    const batches: TenderPatch[][] = [];
    await adapter.scrape('archive', {
      onProgress: () => {},
      onBatch: async (t) => { batches.push(t); cancelAfterFirst = true; },
    }, { isCancelled: () => cancelAfterFirst });
    expect(fetcher).toHaveBeenCalledTimes(1); // only the first (2025) year fetched before stopping
    expect(batches).toHaveLength(1);
  });

  // Real winner block from span.gov.my/tender/view/147 (captured 2026-07-11), simplified
  // to a single row — Task 1's parser tests already cover layout variants exhaustively,
  // so these adapter tests only need to prove the wiring, not the parsing.
  const WINNER_DETAIL_HTML = `<table><tbody>
<tr><td>Nama Pembekal</td><td>UMPSA SERVICES SDN BHD</td><td>Harga Tawaran</td><td>RM132,192.00</td></tr>
</tbody></table>`;

  it('fetches the detail page for each closed tender and merges winners into a follow-up batch', async () => {
    const listingHtml = pageHtml(1, 'REF/OPEN', 'Diiklankan') + pageHtml(2, 'REF/CLOSED', 'Selesai');
    const fetcher = vi.fn(async (url: string) => {
      if (url === 'https://www.span.gov.my/tender/2026') return listingHtml;
      if (url === 'https://www.span.gov.my/tender/view/2') return WINNER_DETAIL_HTML;
      throw new Error(`unexpected url: ${url}`);
    });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    const batches: TenderPatch[][] = [];
    await adapter.scrape('open', { onProgress: () => {}, onBatch: async (t) => { batches.push(t); } });

    expect(fetcher).toHaveBeenCalledWith('https://www.span.gov.my/tender/view/2');
    expect(fetcher).not.toHaveBeenCalledWith('https://www.span.gov.my/tender/view/1');
    const detailBatch = batches.find((b) => b[0]?.winners !== undefined);
    expect(detailBatch).toBeDefined();
    expect(detailBatch![0]!.source.sourceId).toBe('2');
    expect(detailBatch![0]!.winners).toEqual([{ name: 'UMPSA SERVICES SDN BHD', price: 132192 }]);
  });

  it('records winners: null when a closed tender detail page has no winner yet', async () => {
    const listingHtml = pageHtml(2, 'REF/CLOSED', 'Selesai');
    const fetcher = vi.fn(async (url: string) => {
      if (url === 'https://www.span.gov.my/tender/2026') return listingHtml;
      return '<p>Dibatalkan</p>';
    });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    const batches: TenderPatch[][] = [];
    await adapter.scrape('open', { onProgress: () => {}, onBatch: async (t) => { batches.push(t); } });

    const detailBatch = batches.find((b) => b[0]?.winners !== undefined);
    expect(detailBatch).toBeDefined();
    expect(detailBatch![0]!.winners).toBeNull();
  });

  it('skips a tender whose detail fetch fails, without aborting the job', async () => {
    const listingHtml = pageHtml(2, 'REF/A', 'Selesai') + pageHtml(3, 'REF/B', 'Selesai');
    const fetcher = vi.fn(async (url: string) => {
      if (url === 'https://www.span.gov.my/tender/2026') return listingHtml;
      if (url === 'https://www.span.gov.my/tender/view/2') throw new Error('timeout');
      if (url === 'https://www.span.gov.my/tender/view/3') return WINNER_DETAIL_HTML;
      throw new Error(`unexpected url: ${url}`);
    });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const done: string[] = [];
    const batches: TenderPatch[][] = [];
    await adapter.scrape('open', {
      onProgress: () => {},
      onBatch: async (t) => { batches.push(t); },
      onJobDone: (name) => done.push(name),
    });

    expect(done).toEqual(['open-2026']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('https://www.span.gov.my/tender/view/2'));
    const winnerBatches = batches.filter((b) => b[0]?.winners !== undefined);
    expect(winnerBatches).toHaveLength(1);
    expect(winnerBatches[0]![0]!.source.sourceId).toBe('3');
    warnSpy.mockRestore();
  });

  it('stops the detail-fetch loop when isCancelled reports true partway through', async () => {
    const listingHtml = pageHtml(2, 'REF/A', 'Selesai') + pageHtml(3, 'REF/B', 'Selesai');
    const fetcher = vi.fn(async (url: string) => {
      if (url === 'https://www.span.gov.my/tender/2026') return listingHtml;
      return WINNER_DETAIL_HTML;
    });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    let cancel = false;
    const batches: TenderPatch[][] = [];
    await adapter.scrape('open', {
      onProgress: () => {},
      onBatch: async (t) => { batches.push(t); if (t[0]!.winners !== undefined) cancel = true; },
    }, { isCancelled: () => cancel });

    expect(batches).toHaveLength(2); // listing batch + exactly one detail batch
    expect(fetcher).toHaveBeenCalledTimes(2); // listing fetch + first detail fetch only
  });

  it('reports detail-fetch progress as currentPage/lastPage over the closed tenders in the job', async () => {
    const listingHtml = pageHtml(2, 'REF/A', 'Selesai') + pageHtml(3, 'REF/B', 'Selesai');
    const fetcher = vi.fn(async (url: string) => {
      if (url === 'https://www.span.gov.my/tender/2026') return listingHtml;
      return WINNER_DETAIL_HTML;
    });
    const adapter = new SpanAdapter(fetcher, FIXED_NOW);
    const progress: unknown[] = [];
    await adapter.scrape('open', { onProgress: (p) => progress.push({ ...p }), onBatch: async () => {} });

    expect(progress).toContainEqual({
      source: 'span', job: 'open-2026', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 2,
    });
    expect(progress).toContainEqual({
      source: 'span', job: 'open-2026', jobsCompleted: 0, jobsTotal: 1, currentPage: 2, lastPage: 2,
    });
  });
});
