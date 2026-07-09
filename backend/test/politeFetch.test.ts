import { describe, expect, it, vi } from 'vitest';
import { createPoliteFetcher } from '../src/http/politeFetch.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function setup(responses: Array<Response | Error>) {
  const sleeps: number[] = [];
  const sleep = vi.fn(async (ms: number) => { sleeps.push(ms); });
  const fetchImpl = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses queued');
    if (next instanceof Error) throw next;
    return next;
  });
  return { sleeps, sleep, fetchImpl };
}

describe('createPoliteFetcher', () => {
  it('returns parsed JSON and waits baseDelay+jitter before each request', async () => {
    const { sleeps, sleep, fetchImpl } = setup([jsonResponse({ ok: 1 })]);
    const f = createPoliteFetcher({ baseDelayMs: 300, jitterMs: 200, fetchImpl, sleep, random: () => 0.5 });
    await expect(f('http://x/a')).resolves.toEqual({ ok: 1 });
    expect(sleeps).toEqual([400]); // 300 + 0.5*200
  });

  it('sends the identifying User-Agent', async () => {
    const { sleep, fetchImpl } = setup([jsonResponse({})]);
    const f = createPoliteFetcher({ fetchImpl, sleep, random: () => 0 });
    await f('http://x/a');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('TenderAggregatorBot/1.0');
  });

  it('retries with exponential backoff on network error, then succeeds', async () => {
    const { sleeps, sleep, fetchImpl } = setup([new Error('boom'), new Error('boom'), jsonResponse({ ok: 1 })]);
    const f = createPoliteFetcher({ baseDelayMs: 0, jitterMs: 0, fetchImpl, sleep, random: () => 0 });
    await expect(f('http://x/a')).resolves.toEqual({ ok: 1 });
    // delays: pre-req(0), backoff 1000, pre-req(0), backoff 4000, pre-req(0)
    expect(sleeps.filter((ms) => ms > 0)).toEqual([1000, 4000]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails after maxAttempts', async () => {
    const { sleep, fetchImpl } = setup([new Error('a'), new Error('b'), new Error('c')]);
    const f = createPoliteFetcher({ baseDelayMs: 0, jitterMs: 0, fetchImpl, sleep, random: () => 0 });
    await expect(f('http://x/a')).rejects.toThrow('fetch failed after 3 attempts');
  });

  it('honors Retry-After on 429 without consuming an attempt (first time only)', async () => {
    const { sleeps, sleep, fetchImpl } = setup([
      jsonResponse({}, 429, { 'Retry-After': '7' }),
      new Error('x'), new Error('x'), jsonResponse({ ok: 1 }),
    ]);
    const f = createPoliteFetcher({ baseDelayMs: 0, jitterMs: 0, fetchImpl, sleep, random: () => 0 });
    // 4 fetches total: the 429 didn't count, then 3 budgeted attempts
    await expect(f('http://x/a')).resolves.toEqual({ ok: 1 });
    expect(sleeps).toContain(7000);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('uses the 60s penalty on 503 without Retry-After', async () => {
    const { sleeps, sleep, fetchImpl } = setup([jsonResponse({}, 503), jsonResponse({ ok: 1 })]);
    const f = createPoliteFetcher({ baseDelayMs: 0, jitterMs: 0, fetchImpl, sleep, random: () => 0 });
    await expect(f('http://x/a')).resolves.toEqual({ ok: 1 });
    expect(sleeps).toContain(60000);
  });

  it('treats other non-ok statuses as failures consuming attempts', async () => {
    const { sleep, fetchImpl } = setup([jsonResponse({}, 500), jsonResponse({}, 500), jsonResponse({}, 500)]);
    const f = createPoliteFetcher({ baseDelayMs: 0, jitterMs: 0, fetchImpl, sleep, random: () => 0 });
    await expect(f('http://x/a')).rejects.toThrow('fetch failed after 3 attempts');
  });
});

describe('createPoliteFetcher — text mode', () => {
  it('returns raw text and sends Accept: text/html when responseType is "text"', async () => {
    const { sleep, fetchImpl } = setup([new Response('<html>hi</html>', { status: 200 })]);
    const f = createPoliteFetcher({ responseType: 'text', fetchImpl, sleep, random: () => 0 });
    await expect(f('http://x/a')).resolves.toBe('<html>hi</html>');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Accept).toBe('text/html');
  });

  it('still retries/backs off the same way in text mode', async () => {
    const { sleeps, sleep, fetchImpl } = setup([new Error('boom'), new Response('ok', { status: 200 })]);
    const f = createPoliteFetcher({
      responseType: 'text', baseDelayMs: 0, jitterMs: 0, fetchImpl, sleep, random: () => 0,
    });
    await expect(f('http://x/a')).resolves.toBe('ok');
    expect(sleeps.filter((ms) => ms > 0)).toEqual([1000]);
  });
});
