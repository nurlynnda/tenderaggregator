export function parseDdMmYyyy(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (date.getUTCFullYear() !== yyyy || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) {
    return null;
  }
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export function parseRmPrice(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/RM\s*(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : null;
}

export function splitFieldCodes(s: string | null | undefined): string[] {
  if (!s) return [];
  return s.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
}

export function parseIsoDatePrefix(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (date.getUTCFullYear() !== yyyy || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function parseDottedDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (date.getUTCFullYear() !== yyyy || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) {
    return null;
  }
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export function parseDashedDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (date.getUTCFullYear() !== yyyy || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) {
    return null;
  }
  return `${m[3]}-${m[2]}-${m[1]}`;
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export function parseMonthYearToFirstOfMonth(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const monthIndex = MONTH_NAMES.indexOf(m[1]!.toLowerCase());
  if (monthIndex === -1) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${m[2]}-${pad(monthIndex + 1)}-01`;
}
