import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { cancelScrape, fetchFacets, fetchScrapeStatus, fetchSources, fetchTender, fetchTenders, triggerScrape } from '../api/client';
import { fetchAdminUsers, fetchMe, logout, registerRequest, updateUserRole, verifyRegistrationOtp } from '../api/client';
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
    expect((await fetchTender('UTHM/54/P/02/023/2026')).tender.referenceNo).toBe('UTHM/54/P/02/023/2026');
  });

  it('fetchTender throws on 404', async () => {
    await expect(fetchTender('NOPE')).rejects.toThrow();
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

  it('fetchSources returns the sources array', async () => {
    server.use(http.get('/api/sources', () => HttpResponse.json([
      { name: 'span', lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 },
    ])));
    const sources = await fetchSources();
    expect(sources).toEqual([{ name: 'span', lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 }]);
  });

  it('triggerScrape sends source and scope in the request body', async () => {
    let seenBody: unknown;
    server.use(http.post('/api/scrape', async ({ request }) => {
      seenBody = await request.json();
      return HttpResponse.json({ started: true }, { status: 202 });
    }));
    await triggerScrape({ source: 'span', scope: 'full' });
    expect(seenBody).toEqual({ source: 'span', scope: 'full' });
  });

  it('cancelScrape resolves on 200 and throws on 409', async () => {
    server.use(http.post('/api/scrape/cancel', () => HttpResponse.json({ cancelled: true })));
    await expect(cancelScrape()).resolves.toBeUndefined();
    server.use(http.post('/api/scrape/cancel', () => HttpResponse.json({ error: 'nothing running' }, { status: 409 })));
    await expect(cancelScrape()).rejects.toThrow('nothing running');
  });

  it('fetchMe returns the current user, and throws 401 as an error', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json({ name: 'Jane', email: 'jane@example.com', role: 'member' })));
    expect(await fetchMe()).toEqual({ name: 'Jane', email: 'jane@example.com', role: 'member' });
    server.use(http.get('/api/auth/me', () => HttpResponse.json({ error: 'not authenticated' }, { status: 401 })));
    await expect(fetchMe()).rejects.toThrow();
  });

  it('registerRequest posts name/email and resolves on 202', async () => {
    let seenBody: unknown;
    server.use(http.post('/api/auth/register/request', async ({ request }) => {
      seenBody = await request.json();
      return HttpResponse.json({ ok: true }, { status: 202 });
    }));
    await registerRequest({ name: 'Jane', email: 'jane@example.com' });
    expect(seenBody).toEqual({ name: 'Jane', email: 'jane@example.com' });
  });

  it('registerRequest throws on 429', async () => {
    server.use(http.post('/api/auth/register/request', () => HttpResponse.json({ error: 'throttled' }, { status: 429 })));
    await expect(registerRequest({ name: 'Jane', email: 'jane@example.com' })).rejects.toThrow();
  });

  it('verifyRegistrationOtp posts the otp and resolves on 200, throws otherwise', async () => {
    server.use(http.post('/api/auth/register/verify-otp', () => HttpResponse.json({ ok: true })));
    await expect(verifyRegistrationOtp('123456')).resolves.toBeUndefined();
    server.use(http.post('/api/auth/register/verify-otp', () => HttpResponse.json({ error: 'wrong code' }, { status: 400 })));
    await expect(verifyRegistrationOtp('000000')).rejects.toThrow();
  });

  it('logout posts to /api/auth/logout', async () => {
    let called = false;
    server.use(http.post('/api/auth/logout', () => {
      called = true;
      return HttpResponse.json({ ok: true });
    }));
    await logout();
    expect(called).toBe(true);
  });

  it('fetchAdminUsers and updateUserRole hit the admin endpoints', async () => {
    server.use(http.get('/api/admin/users', () => HttpResponse.json({
      users: [{ id: '1', name: 'A', email: 'a@example.com', role: 'admin', createdAt: '2026-07-17T00:00:00.000Z' }],
    })));
    expect(await fetchAdminUsers()).toEqual([{ id: '1', name: 'A', email: 'a@example.com', role: 'admin', createdAt: '2026-07-17T00:00:00.000Z' }]);

    server.use(http.patch('/api/admin/users/1/role', () => HttpResponse.json({ id: '1', name: 'A', email: 'a@example.com', role: 'member', createdAt: '2026-07-17T00:00:00.000Z' })));
    expect((await updateUserRole('1', 'member')).role).toBe('member');
  });
});
