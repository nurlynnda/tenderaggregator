export interface RateLimiter {
  consume(key: string, opts: { limit: number; windowMs: number }): boolean;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  consume(key: string, opts: { limit: number; windowMs: number }): boolean {
    const t = this.now();
    const windowStart = t - opts.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > windowStart);
    if (recent.length >= opts.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}
