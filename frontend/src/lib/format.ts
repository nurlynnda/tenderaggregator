export function formatMYR(n: number): string {
  return `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-MY');
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatDate(date: string | null): string | null {
  if (date === null) return null;
  const match = ISO_DATE.exec(date);
  if (!match) return date;
  const [, year, month, day] = match;
  return `${day}-${month}-${year}`;
}

// Sources whose name is an acronym (e.g. "llm" for Lembaga Lebuhraya Malaysia, "span" for
// Suruhanjaya Perkhidmatan Air Negara, "kwsp" for Kumpulan Wang Simpanan Pekerja) read oddly in
// lowercase or with only their first letter capitalised, so they're always shown fully uppercase.
const UPPERCASE_SOURCES = new Set(['llm', 'span', 'kwsp']);

export function formatSourceLabel(source: string): string {
  return UPPERCASE_SOURCES.has(source.toLowerCase()) ? source.toUpperCase() : source;
}

// Capitalizes the first letter of every word, leaving the rest of each word untouched — used
// for short plain-English tags (procurement type, "d left") that come from the backend lowercase.
export function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
