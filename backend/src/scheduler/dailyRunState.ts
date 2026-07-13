import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface DailyRunState {
  lastRunDate: string | null;
}

export function createDailyRunStateStore(dataDir: string) {
  const filePath = join(dataDir, 'daily-schedule.json');
  return {
    async load(): Promise<string | null> {
      try {
        const raw = JSON.parse(await readFile(filePath, 'utf8')) as DailyRunState;
        return raw.lastRunDate ?? null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async save(date: string): Promise<void> {
      await mkdir(dataDir, { recursive: true });
      const tmp = `${filePath}.tmp`;
      const state: DailyRunState = { lastRunDate: date };
      await writeFile(tmp, JSON.stringify(state), 'utf8');
      await rename(tmp, filePath);
    },
  };
}
