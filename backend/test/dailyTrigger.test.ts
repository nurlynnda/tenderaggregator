import { describe, expect, it } from 'vitest';
import { nextFireTime, mytDateString, missedToday } from '../src/scheduler/dailyTrigger.js';

describe('nextFireTime', () => {
  it('returns 12:01pm MYT today when now is before that today', () => {
    const now = new Date('2026-07-11T00:00:00.000Z'); // 08:00 MYT
    expect(nextFireTime(now)).toEqual(new Date('2026-07-11T04:01:00.000Z'));
  });

  it('rolls to tomorrow when now is exactly at the cutoff', () => {
    const now = new Date('2026-07-11T04:01:00.000Z'); // exactly 12:01pm MYT
    expect(nextFireTime(now)).toEqual(new Date('2026-07-12T04:01:00.000Z'));
  });

  it('returns today when now is one second before the cutoff', () => {
    const now = new Date('2026-07-11T04:00:59.000Z');
    expect(nextFireTime(now)).toEqual(new Date('2026-07-11T04:01:00.000Z'));
  });

  it('rolls to tomorrow when now is after the cutoff today', () => {
    const now = new Date('2026-07-11T10:00:00.000Z'); // 18:00 MYT
    expect(nextFireTime(now)).toEqual(new Date('2026-07-12T04:01:00.000Z'));
  });

  it('rolls across a month boundary', () => {
    const now = new Date('2026-07-31T10:00:00.000Z');
    expect(nextFireTime(now)).toEqual(new Date('2026-08-01T04:01:00.000Z'));
  });

  it('rolls across a year boundary', () => {
    const now = new Date('2026-12-31T10:00:00.000Z');
    expect(nextFireTime(now)).toEqual(new Date('2027-01-01T04:01:00.000Z'));
  });
});

describe('mytDateString', () => {
  it('returns the MYT calendar date for a UTC morning timestamp', () => {
    expect(mytDateString(new Date('2026-07-11T00:00:00.000Z'))).toBe('2026-07-11'); // 08:00 MYT
  });

  it('rolls the date forward for a UTC evening timestamp (past MYT midnight)', () => {
    expect(mytDateString(new Date('2026-07-11T20:00:00.000Z'))).toBe('2026-07-12'); // 04:00 MYT next day
  });
});

describe('missedToday', () => {
  it('is false when lastRunDate is already today (MYT)', () => {
    const now = new Date('2026-07-11T10:00:00.000Z'); // 18:00 MYT
    expect(missedToday(now, '2026-07-11')).toBe(false);
  });

  it('is false when lastRunDate is null but the noon cutoff has not passed yet today', () => {
    const now = new Date('2026-07-11T00:00:00.000Z'); // 08:00 MYT
    expect(missedToday(now, null)).toBe(false);
  });

  it('is true when lastRunDate is null and the noon cutoff has already passed today', () => {
    const now = new Date('2026-07-11T10:00:00.000Z'); // 18:00 MYT
    expect(missedToday(now, null)).toBe(true);
  });

  it('is true when lastRunDate is yesterday and the noon cutoff has already passed today', () => {
    const now = new Date('2026-07-11T10:00:00.000Z'); // 18:00 MYT
    expect(missedToday(now, '2026-07-10')).toBe(true);
  });

  it('is false when lastRunDate is yesterday but the noon cutoff has not passed yet today', () => {
    const now = new Date('2026-07-11T00:00:00.000Z'); // 08:00 MYT
    expect(missedToday(now, '2026-07-10')).toBe(false);
  });
});
