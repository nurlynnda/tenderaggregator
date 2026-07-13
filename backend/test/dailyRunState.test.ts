import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDailyRunStateStore } from '../src/scheduler/dailyRunState.js';

describe('createDailyRunStateStore', () => {
  it('load() returns null when no state file exists yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tms-daily-'));
    const store = createDailyRunStateStore(dir);
    expect(await store.load()).toBeNull();
  });

  it('save() then load() round-trips the date', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tms-daily-'));
    const store = createDailyRunStateStore(dir);
    await store.save('2026-07-11');
    expect(await store.load()).toBe('2026-07-11');
  });

  it('save() overwrites a previously saved date', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tms-daily-'));
    const store = createDailyRunStateStore(dir);
    await store.save('2026-07-10');
    await store.save('2026-07-11');
    expect(await store.load()).toBe('2026-07-11');
  });
});
