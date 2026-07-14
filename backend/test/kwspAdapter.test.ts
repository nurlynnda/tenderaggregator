import { describe, expect, it, vi } from 'vitest';
import type { TenderPatch } from '@tms/shared';
import { KwspAdapter } from '../src/scrapers/kwsp/adapter.js';

const PAGE_URL = 'https://www.kwsp.gov.my/en/corporate/procurement/tenders';

const OPEN_TENDER_HTML = `<div class="card-bg">
  <h4 class="component-heading"></h4>
  <h4 class="component-heading"></h4>
  <h4 class="component-heading">Sample Open Tender</h4>
  <div class="component-paragraph">
    <h4><span class="lead">Tender No.</span></h4>
    <ul><li><p>Doc1000000001</p></li></ul>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Open Date</span></h4>
    <ul><li>01.07.2026 (Wednesday)</li></ul>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Closing Date</span></h4>
    <ul><li><p>15.07.2026 (Wednesday)</p></li></ul>
  </div>
  <a href="/documents/d/guest/sample-open-tender"><h6>More Info</h6></a>
</div>`;

const RESULT_HTML = `<div class="card-bg">
  <div class="accordion-card">
    <div class="accordion-item">
      <div class="accordion-header"><h3>July 2026</h3></div>
      <div class="accordion-content">
        <p>Sample Result Tender<br> <em>Doc2000000002<br> Winner Sdn Bhd</em></p>
      </div>
    </div>
  </div>
</div>`;

const PAGE_HTML = OPEN_TENDER_HTML + RESULT_HTML;

describe('KwspAdapter — job model', () => {
  it('reports "results" as the only archive job', () => {
    const adapter = new KwspAdapter(vi.fn());
    expect(adapter.archiveJobNames()).toEqual(['results']);
  });

  it('reports "results" as its only results job (same as its only archive job)', () => {
    const adapter = new KwspAdapter(vi.fn());
    expect(adapter.resultsJobNames()).toEqual(['results']);
  });

  it('scope=open fetches the page once and emits only the open job', async () => {
    const fetcher = vi.fn(async () => PAGE_HTML);
    const adapter = new KwspAdapter(fetcher);
    const batches: TenderPatch[][] = [];
    const done: string[] = [];
    await adapter.scrape('open', {
      onProgress: () => {}, onBatch: async (t) => { batches.push(t); }, onJobDone: (n) => done.push(n),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(PAGE_URL);
    expect(done).toEqual(['open']);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((t) => t.referenceNo)).toEqual(['Doc1000000001']);
  });

  it('scope=archive fetches the page once and emits only the results job', async () => {
    const fetcher = vi.fn(async () => PAGE_HTML);
    const adapter = new KwspAdapter(fetcher);
    const batches: TenderPatch[][] = [];
    const done: string[] = [];
    await adapter.scrape('archive', {
      onProgress: () => {}, onBatch: async (t) => { batches.push(t); }, onJobDone: (n) => done.push(n),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(done).toEqual(['results']);
    expect(batches[0]!.map((t) => t.referenceNo)).toEqual(['Doc2000000002']);
  });

  it('scope=all fetches the page exactly once and emits both jobs in order', async () => {
    const fetcher = vi.fn(async () => PAGE_HTML);
    const adapter = new KwspAdapter(fetcher);
    const done: string[] = [];
    await adapter.scrape('all', { onProgress: () => {}, onBatch: async () => {}, onJobDone: (n) => done.push(n) });
    expect(fetcher).toHaveBeenCalledTimes(1); // one page fetch serves both jobs, not two
    expect(done).toEqual(['open', 'results']);
  });

  it('skips the results job (and never fetches) when already backfilled and scope=archive', async () => {
    const fetcher = vi.fn(async () => PAGE_HTML);
    const adapter = new KwspAdapter(fetcher);
    const onBatch = vi.fn(async () => {});
    await adapter.scrape('archive', { onProgress: () => {}, onBatch }, { skipJobNames: new Set(['results']) });
    expect(fetcher).not.toHaveBeenCalled();
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('still fetches once for the open job even when results is already backfilled, scope=all', async () => {
    const fetcher = vi.fn(async () => PAGE_HTML);
    const adapter = new KwspAdapter(fetcher);
    const done: string[] = [];
    await adapter.scrape('all', { onProgress: () => {}, onBatch: async () => {}, onJobDone: (n) => done.push(n) }, {
      skipJobNames: new Set(['results']),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(done).toEqual(['open']);
  });

  it('reports progress with jobsTotal reflecting only the in-scope jobs', async () => {
    const fetcher = vi.fn(async () => PAGE_HTML);
    const adapter = new KwspAdapter(fetcher);
    const progress: unknown[] = [];
    await adapter.scrape('all', { onProgress: (p) => progress.push({ ...p }), onBatch: async () => {} });
    expect(progress).toEqual([
      { source: 'kwsp', job: 'open', jobsCompleted: 0, jobsTotal: 2, currentPage: 1, lastPage: 1 },
      { source: 'kwsp', job: 'results', jobsCompleted: 1, jobsTotal: 2, currentPage: 1, lastPage: 1 },
    ]);
  });

  it('rejects when the fetcher fails, without calling onBatch', async () => {
    const fetcher = vi.fn(async () => { throw new Error('fetch failed after 3 attempts: x'); });
    const adapter = new KwspAdapter(fetcher);
    const onBatch = vi.fn(async () => {});
    await expect(adapter.scrape('open', { onProgress: () => {}, onBatch })).rejects.toThrow('fetch failed');
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('stops before the results job when isCancelled reports true, without throwing', async () => {
    const fetcher = vi.fn(async () => PAGE_HTML);
    const adapter = new KwspAdapter(fetcher);
    let cancelAfterFirst = false;
    const done: string[] = [];
    await adapter.scrape('all', {
      onProgress: () => {},
      onBatch: async () => { cancelAfterFirst = true; },
      onJobDone: (n) => done.push(n),
    }, { isCancelled: () => cancelAfterFirst });
    expect(done).toEqual(['open']);
    expect(fetcher).toHaveBeenCalledTimes(1); // cancellation only stops the job loop, not the shared fetch
  });
});
