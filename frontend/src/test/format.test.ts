import { describe, expect, it } from 'vitest';
import { formatDate, formatMYR } from '../lib/format';

describe('formatMYR', () => {
  it('formats a number with thousands separators and 2 decimal places, RM-prefixed', () => {
    expect(formatMYR(1234567.5)).toBe('RM 1,234,567.50');
  });

  it('formats zero correctly', () => {
    expect(formatMYR(0)).toBe('RM 0.00');
  });

  it('formats a whole number with two trailing zeros', () => {
    expect(formatMYR(600000)).toBe('RM 600,000.00');
  });
});

describe('formatDate', () => {
  it('converts an ISO date (YYYY-MM-DD) to DD-MM-YYYY', () => {
    expect(formatDate('2026-07-17')).toBe('17-07-2026');
  });

  it('pads single-digit day and month', () => {
    expect(formatDate('2026-01-05')).toBe('05-01-2026');
  });

  it('returns null unchanged', () => {
    expect(formatDate(null)).toBeNull();
  });

  it('returns a non-ISO-date string unchanged', () => {
    expect(formatDate('not a date')).toBe('not a date');
  });
});
