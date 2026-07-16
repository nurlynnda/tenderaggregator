import { describe, expect, it } from 'vitest';
import { createDailyRunStateStore } from '../src/scheduler/dailyRunState.js';
import type { SchedulerStateDoc } from '../src/scheduler/dailyRunState.js';
import { FakeCollection } from './support/fakeMongoCollection.js';

describe('createDailyRunStateStore', () => {
  it('load() returns null when no state document exists yet', async () => {
    const store = createDailyRunStateStore(new FakeCollection<SchedulerStateDoc>());
    expect(await store.load()).toBeNull();
  });

  it('save() then load() round-trips the date', async () => {
    const store = createDailyRunStateStore(new FakeCollection<SchedulerStateDoc>());
    await store.save('2026-07-11');
    expect(await store.load()).toBe('2026-07-11');
  });

  it('save() overwrites a previously saved date', async () => {
    const store = createDailyRunStateStore(new FakeCollection<SchedulerStateDoc>());
    await store.save('2026-07-10');
    await store.save('2026-07-11');
    expect(await store.load()).toBe('2026-07-11');
  });

  it('a second store backed by the same underlying collection sees a saved date', async () => {
    const collection = new FakeCollection<SchedulerStateDoc>();
    const store1 = createDailyRunStateStore(collection);
    await store1.save('2026-07-11');
    const store2 = createDailyRunStateStore(collection);
    expect(await store2.load()).toBe('2026-07-11');
  });
});
