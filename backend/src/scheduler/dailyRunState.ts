import type { QueryableCollection } from '../storage/tenderDoc.js';

export interface SchedulerStateDoc {
  _id: 'daily';
  lastRunDate: string | null;
}

export function createDailyRunStateStore(collection: QueryableCollection<SchedulerStateDoc>) {
  return {
    async load(): Promise<string | null> {
      const doc = await collection.findOne({ _id: 'daily' });
      return doc?.lastRunDate ?? null;
    },
    async save(date: string): Promise<void> {
      await collection.replaceOne({ _id: 'daily' }, { _id: 'daily', lastRunDate: date }, { upsert: true });
    },
  };
}
