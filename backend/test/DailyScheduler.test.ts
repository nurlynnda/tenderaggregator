// backend/test/DailyScheduler.test.ts
import { describe, expect, it, vi } from 'vitest';
import { DailyScheduler } from '../src/scheduler/DailyScheduler.js';

type FakeTimer = { fn: () => void; ms: number };

function fakeTimerFns() {
  const timers: FakeTimer[] = [];
  const cleared: unknown[] = [];
  let nextHandle = 1;
  return {
    timers,
    cleared,
    setTimeoutFn: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return nextHandle++ as unknown as NodeJS.Timeout;
    },
    clearTimeoutFn: (handle: NodeJS.Timeout) => { cleared.push(handle); },
  };
}

describe('DailyScheduler', () => {
  it('arms a timer for the next 12:01pm MYT fire time when today has already run', async () => {
    const clock = new Date('2026-07-11T00:00:00.000Z'); // 08:00 MYT, before noon
    const { timers, setTimeoutFn, clearTimeoutFn } = fakeTimerFns();
    const scheduler = new DailyScheduler({
      run: vi.fn(async () => {}),
      loadLastRunDate: async () => '2026-07-11', // already ran today
      saveLastRunDate: vi.fn(async () => {}),
      now: () => clock,
      setTimeoutFn,
      clearTimeoutFn,
    });
    await scheduler.start();
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(new Date('2026-07-11T04:01:00.000Z').getTime() - clock.getTime());
  });

  it('fires immediately on start when catch-up is needed (missed today, already past noon MYT)', async () => {
    const clock = new Date('2026-07-11T10:00:00.000Z'); // 18:00 MYT, after noon
    const run = vi.fn(async () => {});
    const saveLastRunDate = vi.fn(async () => {});
    const { timers, setTimeoutFn, clearTimeoutFn } = fakeTimerFns();
    const scheduler = new DailyScheduler({
      run,
      loadLastRunDate: async () => '2026-07-10', // last ran yesterday
      saveLastRunDate,
      now: () => clock,
      setTimeoutFn,
      clearTimeoutFn,
    });
    await scheduler.start();
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget run() settle
    expect(saveLastRunDate).toHaveBeenCalledWith('2026-07-11');
    expect(run).toHaveBeenCalledTimes(1);
    // Tomorrow's timer was armed immediately, independent of run() completing.
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(new Date('2026-07-12T04:01:00.000Z').getTime() - clock.getTime());
  });

  it('on a normal scheduled fire, saves the date and arms tomorrow before run() resolves', async () => {
    const clock = new Date('2026-07-11T00:00:00.000Z'); // 08:00 MYT, before noon
    let releaseRun!: () => void;
    const gate = new Promise<void>((r) => { releaseRun = r; });
    const run = vi.fn(async () => gate);
    const saveLastRunDate = vi.fn(async () => {});
    const { timers, setTimeoutFn, clearTimeoutFn } = fakeTimerFns();
    const scheduler = new DailyScheduler({
      run,
      loadLastRunDate: async () => null,
      saveLastRunDate,
      now: () => clock,
      setTimeoutFn,
      clearTimeoutFn,
    });
    await scheduler.start();
    expect(timers).toHaveLength(1); // today's 12:01pm timer armed
    timers[0]!.fn(); // simulate the timer firing
    await new Promise((r) => setTimeout(r, 0));
    expect(saveLastRunDate).toHaveBeenCalledWith('2026-07-11');
    expect(run).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(2); // tomorrow's timer armed even though run() hasn't resolved yet
    releaseRun();
  });

  it('logs via onError and still arms the next day when run() throws', async () => {
    const clock = new Date('2026-07-11T00:00:00.000Z');
    const onError = vi.fn();
    const { timers, setTimeoutFn, clearTimeoutFn } = fakeTimerFns();
    const scheduler = new DailyScheduler({
      run: vi.fn(async () => { throw new Error('scrape failed'); }),
      loadLastRunDate: async () => null,
      saveLastRunDate: vi.fn(async () => {}),
      now: () => clock,
      setTimeoutFn,
      clearTimeoutFn,
      onError,
    });
    await scheduler.start();
    timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(timers).toHaveLength(2); // next day's timer still armed
  });

  it('stop() clears the pending timer', async () => {
    const clock = new Date('2026-07-11T00:00:00.000Z');
    const { cleared, setTimeoutFn, clearTimeoutFn } = fakeTimerFns();
    const scheduler = new DailyScheduler({
      run: vi.fn(async () => {}),
      loadLastRunDate: async () => null,
      saveLastRunDate: vi.fn(async () => {}),
      now: () => clock,
      setTimeoutFn,
      clearTimeoutFn,
    });
    await scheduler.start();
    scheduler.stop();
    expect(cleared).toHaveLength(1);
  });
});
