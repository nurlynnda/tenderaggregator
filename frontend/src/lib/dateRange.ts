export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysISO(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysUntil(closingDate: string): number {
  const MS_PER_DAY = 86_400_000;
  const diff = Date.parse(`${closingDate}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`);
  return Math.round(diff / MS_PER_DAY);
}
