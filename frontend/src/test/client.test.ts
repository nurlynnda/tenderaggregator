import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { fetchFacets, fetchScrapeStatus, fetchTender, fetchTenders, triggerScrape } from '../api/client';
import { defaultFacets, defaultPage, server } from './mocks';

describe('api client', () => {
  it('fetchTenders passes query params and returns the page', async () => {
    let seenUrl = '';
    server.use(http.get('/api/tenders', ({ request }) => {
      seenUrl = request.url;
      return HttpResponse.json(defaultPage);
    }));
    const page = await fetchTenders({ search: 'makmal', status: 'open' });
    expect(page.total).toBe(1);
    expect(seenUrl).toContain('search=makmal');
    expect(seenUrl).toContain('status=open');
  });

  it('fetchFacets / fetchScrapeStatus / fetchTender return typed bodies', async () => {
    expect(await fetchFacets()).toEqual(defaultFacets);
    expect((await fetchScrapeStatus()).state).toBe('idle');
    expect((await fetchTender('myprocurement:1')).tender.id).toBe('myprocurement:1');
  });

  it('fetchTender throws on 404', async () => {
    await expect(fetchTender('nope:1')).rejects.toThrow();
  });

  it('triggerScrape resolves on 202 and throws on 409', async () => {
    await expect(triggerScrape()).resolves.toBeUndefined();
    server.use(http.post('/api/scrape', () => HttpResponse.json({ error: 'running' }, { status: 409 })));
    await expect(triggerScrape()).rejects.toThrow('scrape already running');
  });

  it('fetchTenders omits empty-string params from the query string', async () => {
    let seenUrl = '';
    server.use(http.get('/api/tenders', ({ request }) => {
      seenUrl = request.url;
      return HttpResponse.json(defaultPage);
    }));
    await fetchTenders({ search: '', status: 'open' });
    expect(seenUrl).not.toContain('search=');
    expect(seenUrl).toContain('status=open');
  });

  it('triggerScrape throws a generic error on other non-ok statuses', async () => {
    server.use(http.post('/api/scrape', () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
    await expect(triggerScrape()).rejects.toThrow('scrape trigger failed: 500');
  });
});
