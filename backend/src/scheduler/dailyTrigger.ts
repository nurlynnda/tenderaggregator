const FIRE_UTC_HOUR = 4; // 12:01pm MYT (UTC+8, no DST) is 04:01 UTC
const FIRE_MINUTE = 1;

// The next 12:01pm Malaysia-time instant strictly after `now`.
export function nextFireTime(now: Date): Date {
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    FIRE_UTC_HOUR, FIRE_MINUTE, 0, 0,
  ));
  if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1);
  return candidate;
}

// Today's calendar date in Malaysia time, as YYYY-MM-DD. Malaysia is UTC+8 year-round
// (no DST), so shifting by +8h and reading UTC fields gives the correct local date.
export function mytDateString(now: Date): string {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

// True when today's 12:01pm MYT run hasn't happened yet and that cutoff has already passed —
// used on startup to catch up immediately instead of waiting for tomorrow.
export function missedToday(now: Date, lastRunDate: string | null): boolean {
  const today = mytDateString(now);
  if (lastRunDate === today) return false;
  const cutoff = new Date(`${today}T12:01:00+08:00`);
  return now >= cutoff;
}
