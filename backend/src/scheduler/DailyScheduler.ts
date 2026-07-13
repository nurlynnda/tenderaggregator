// backend/src/scheduler/DailyScheduler.ts
import { missedToday, mytDateString, nextFireTime } from './dailyTrigger.js';

export interface DailySchedulerDeps {
  run: () => Promise<void>;
  loadLastRunDate: () => Promise<string | null>;
  saveLastRunDate: (date: string) => Promise<void>;
  now?: () => Date;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  onError?: (err: unknown) => void;
}

export class DailyScheduler {
  private readonly now: () => Date;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimeoutFn: (handle: NodeJS.Timeout) => void;
  private readonly onError: (err: unknown) => void;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: DailySchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));
    this.onError = deps.onError ?? ((err) => console.error('[daily] run failed:', err));
  }

  async start(): Promise<void> {
    const lastRunDate = await this.deps.loadLastRunDate();
    if (missedToday(this.now(), lastRunDate)) {
      this.fire();
    } else {
      this.armNext();
    }
  }

  stop(): void {
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }

  private armNext(): void {
    const delayMs = nextFireTime(this.now()).getTime() - this.now().getTime();
    this.timer = this.setTimeoutFn(() => this.fire(), delayMs);
  }

  // Schedules tomorrow's fire immediately (wall-clock based), then runs today's work in the
  // background — so a slow run() (e.g. waiting out a concurrent scrape) never delays tomorrow's
  // trigger.
  private fire(): void {
    const today = mytDateString(this.now());
    this.armNext();
    void this.runOnce(today);
  }

  private async runOnce(today: string): Promise<void> {
    try {
      await this.deps.saveLastRunDate(today);
      await this.deps.run();
    } catch (err) {
      this.onError(err);
    }
  }
}
