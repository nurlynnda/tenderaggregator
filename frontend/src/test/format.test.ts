import { describe, expect, it } from 'vitest';
import { formatMYR } from '../lib/format';

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
