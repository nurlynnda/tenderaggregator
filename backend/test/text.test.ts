import { describe, expect, it } from 'vitest';
import { parseDdMmYyyy, parseRmPrice, splitFieldCodes } from '../src/parsing/text.js';

describe('parseDdMmYyyy', () => {
  it('parses dd/mm/yyyy into ISO date', () => {
    expect(parseDdMmYyyy('07/07/2026')).toBe('2026-07-07');
    expect(parseDdMmYyyy(' 17/07/2026 ')).toBe('2026-07-17');
  });
  it('returns null for invalid or missing input', () => {
    expect(parseDdMmYyyy('2026-07-07')).toBeNull();
    expect(parseDdMmYyyy('32/01/2026')).toBeNull();
    expect(parseDdMmYyyy('30/02/2026')).toBeNull();
    expect(parseDdMmYyyy('')).toBeNull();
    expect(parseDdMmYyyy(null)).toBeNull();
    expect(parseDdMmYyyy(undefined)).toBeNull();
  });
});

describe('parseRmPrice', () => {
  it('parses RM amounts with thousands separators', () => {
    expect(parseRmPrice('RM 28,800.00')).toBe(28800);
    expect(parseRmPrice('RM 1,084,000.00')).toBe(1084000);
    expect(parseRmPrice('rm 20,000.00')).toBe(20000);
  });
  it('returns null when no parseable amount', () => {
    expect(parseRmPrice('')).toBeNull();
    expect(parseRmPrice('TIADA')).toBeNull();
    expect(parseRmPrice(null)).toBeNull();
    expect(parseRmPrice(undefined)).toBeNull();
  });
});

describe('splitFieldCodes', () => {
  it('splits comma-separated codes and trims', () => {
    expect(splitFieldCodes('221001, 221002, 221003')).toEqual(['221001', '221002', '221003']);
    expect(splitFieldCodes('E05, E32')).toEqual(['E05', 'E32']);
    expect(splitFieldCodes('060501')).toEqual(['060501']);
  });
  it('returns [] for empty input', () => {
    expect(splitFieldCodes('')).toEqual([]);
    expect(splitFieldCodes(null)).toEqual([]);
    expect(splitFieldCodes(undefined)).toEqual([]);
  });
});
