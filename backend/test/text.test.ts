import { describe, expect, it } from 'vitest';
import {
  parseDdMmYyyy, parseDottedDate, parseIsoDatePrefix, parseMonthYearToFirstOfMonth,
  parseRmPrice, splitFieldCodes,
} from '../src/parsing/text.js';

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

describe('parseIsoDatePrefix', () => {
  it('parses a bare ISO date', () => {
    expect(parseIsoDatePrefix('2026-06-22')).toBe('2026-06-22');
  });
  it('parses an ISO date with a trailing time, dropping the time', () => {
    expect(parseIsoDatePrefix('2026-07-06 12:00PM')).toBe('2026-07-06');
  });
  it('returns null for invalid or missing input', () => {
    expect(parseIsoDatePrefix('2026-13-01')).toBeNull(); // no month 13
    expect(parseIsoDatePrefix('2026-02-30')).toBeNull(); // no Feb 30
    expect(parseIsoDatePrefix('22/06/2026')).toBeNull(); // wrong format
    expect(parseIsoDatePrefix('')).toBeNull();
    expect(parseIsoDatePrefix(null)).toBeNull();
    expect(parseIsoDatePrefix(undefined)).toBeNull();
  });
});

describe('parseDottedDate', () => {
  it('parses dd.mm.yyyy into ISO date, ignoring trailing weekday text', () => {
    expect(parseDottedDate('06.07.2026 (Monday)')).toBe('2026-07-06');
    expect(parseDottedDate('03.08.2026 (Monday)')).toBe('2026-08-03');
  });
  it('ignores a non-breaking space before the trailing weekday', () => {
    expect(parseDottedDate('23.07.2026 (Thursday)')).toBe('2026-07-23');
  });
  it('returns null for invalid or missing input', () => {
    expect(parseDottedDate('32.01.2026 (Friday)')).toBeNull(); // no day 32
    expect(parseDottedDate('30.02.2026 (Monday)')).toBeNull(); // no Feb 30
    expect(parseDottedDate('07/07/2026')).toBeNull(); // wrong separator
    expect(parseDottedDate('')).toBeNull();
    expect(parseDottedDate(null)).toBeNull();
    expect(parseDottedDate(undefined)).toBeNull();
  });
});

describe('parseMonthYearToFirstOfMonth', () => {
  it('parses "Month YYYY" into the 1st of that month', () => {
    expect(parseMonthYearToFirstOfMonth('March 2026')).toBe('2026-03-01');
    expect(parseMonthYearToFirstOfMonth('December 2025')).toBe('2025-12-01');
    expect(parseMonthYearToFirstOfMonth('January 2026')).toBe('2026-01-01');
  });
  it('is case-insensitive on the month name', () => {
    expect(parseMonthYearToFirstOfMonth('march 2026')).toBe('2026-03-01');
  });
  it('returns null for invalid or missing input', () => {
    expect(parseMonthYearToFirstOfMonth('Marchy 2026')).toBeNull();
    expect(parseMonthYearToFirstOfMonth('2026')).toBeNull();
    expect(parseMonthYearToFirstOfMonth('March')).toBeNull();
    expect(parseMonthYearToFirstOfMonth('')).toBeNull();
    expect(parseMonthYearToFirstOfMonth(null)).toBeNull();
    expect(parseMonthYearToFirstOfMonth(undefined)).toBeNull();
  });
});
