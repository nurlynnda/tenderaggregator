export function formatMYR(n: number): string {
  return `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatDate(date: string | null): string | null {
  if (date === null) return null;
  const match = ISO_DATE.exec(date);
  if (!match) return date;
  const [, year, month, day] = match;
  return `${day}-${month}-${year}`;
}
