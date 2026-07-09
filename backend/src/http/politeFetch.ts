export interface PoliteFetcherOptions {
  baseDelayMs?: number;
  jitterMs?: number;
  maxAttempts?: number;
  backoffMs?: number[];
  penaltyMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  responseType?: 'json' | 'text';
}

const USER_AGENT = 'TenderAggregatorBot/1.0';
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createPoliteFetcher(opts: PoliteFetcherOptions = {}) {
  const baseDelayMs = opts.baseDelayMs ?? (Number(process.env.SCRAPE_DELAY_MS) || 300);
  const jitterMs = opts.jitterMs ?? 200;
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffMs = opts.backoffMs ?? [1000, 4000, 16000];
  const penaltyMs = opts.penaltyMs ?? 60000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const responseType = opts.responseType ?? 'json';
  const accept = responseType === 'text' ? 'text/html' : 'application/json';

  return async function politeFetch(url: string): Promise<unknown> {
    let attempt = 0;
    let rateLimitGraceUsed = false;

    while (attempt < maxAttempts) {
      await sleep(baseDelayMs + random() * jitterMs);
      try {
        const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept } });
        if (res.ok) return await (responseType === 'text' ? res.text() : res.json());

        if (res.status === 429 || res.status === 503) {
          const retryAfter = Number(res.headers.get('Retry-After'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : penaltyMs;
          await sleep(waitMs);
          if (!rateLimitGraceUsed) {
            rateLimitGraceUsed = true; // first rate-limit wait doesn't consume an attempt
            continue;
          }
        }
        attempt += 1;
      } catch {
        attempt += 1;
      }
      if (attempt < maxAttempts) {
        await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? penaltyMs);
      }
    }
    throw new Error(`fetch failed after ${maxAttempts} attempts: ${url}`);
  };
}
