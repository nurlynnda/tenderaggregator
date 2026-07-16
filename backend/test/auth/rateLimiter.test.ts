import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter } from '../../src/auth/rateLimiter.js';

describe('InMemoryRateLimiter', () => {
  it('allows up to the limit within the window, then blocks', () => {
    const limiter = new InMemoryRateLimiter(() => 1000);
    expect(limiter.consume('k', { limit: 2, windowMs: 1000 })).toBe(true);
    expect(limiter.consume('k', { limit: 2, windowMs: 1000 })).toBe(true);
    expect(limiter.consume('k', { limit: 2, windowMs: 1000 })).toBe(false);
  });

  it('allows again once the window has slid past old hits', () => {
    let t = 0;
    const limiter = new InMemoryRateLimiter(() => t);
    expect(limiter.consume('k', { limit: 1, windowMs: 1000 })).toBe(true);
    expect(limiter.consume('k', { limit: 1, windowMs: 1000 })).toBe(false);
    t = 1500;
    expect(limiter.consume('k', { limit: 1, windowMs: 1000 })).toBe(true);
  });

  it('tracks separate keys independently', () => {
    const limiter = new InMemoryRateLimiter(() => 0);
    expect(limiter.consume('a', { limit: 1, windowMs: 1000 })).toBe(true);
    expect(limiter.consume('b', { limit: 1, windowMs: 1000 })).toBe(true);
  });
});
