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
