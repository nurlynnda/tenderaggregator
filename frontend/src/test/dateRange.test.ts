import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDaysISO, daysUntil, todayISO } from '../lib/dateRange';

describe('dateRange', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T09:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('todayISO returns the current date as YYYY-MM-DD', () => {
    expect(todayISO()).toBe('2026-07-13');
  });

  it('addDaysISO adds whole days to a base ISO date', () => {
    expect(addDaysISO('2026-07-13', 7)).toBe('2026-07-20');
  });

  it('addDaysISO handles month rollover', () => {
    expect(addDaysISO('2026-07-28', 5)).toBe('2026-08-02');
  });

  describe('daysUntil', () => {
    it('returns 0 when the closing date is today', () => {
      expect(daysUntil('2026-07-13')).toBe(0);
    });

    it('returns a positive count for a future date', () => {
      expect(daysUntil('2026-07-20')).toBe(7);
    });

    it('returns a negative count for a past date', () => {
      expect(daysUntil('2026-07-10')).toBe(-3);
    });
  });
});
