import * as cheerio from 'cheerio';
import { TenderPatchSchema, computeDedupKey, type TenderEvent, type TenderPatch } from '@tms/shared';
import { parseDashedDate, parseDottedDate, parseIsoDatePrefix } from '../../parsing/text.js';

export interface LlmDetailContext {
  sourceId: string;
  sourceUrl: string;
  status: 'open' | 'closed';
  now?: () => string;
}

const SOURCE = 'llm';
const AGENCY = 'Lembaga Lebuhraya Malaysia (LLM)';

export function parseLlmDetailHtml(html: string, ctx: LlmDetailContext): TenderPatch | null {
  const $ = cheerio.load(html);
  const panel = $('#tender-table-head');
  if (panel.length === 0) return null;

  const title = clean(panel.find('header').first().text());
  if (!title) return null;

  const raw: Record<string, string> = { Tajuk: title };
  panel.find('table.tender-content tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const label = clean($(cells[0]).text());
    const value = clean($(cells[1]).text());
    if (!label) return;
    raw[label] = value;
  });

  const now = ctx.now ?? (() => new Date().toISOString());
  const referenceNo = extractReferenceNo(title);
  const fallback = `${SOURCE}:${ctx.sourceId}`;
  const procurementType = inferProcurementType(raw['Jenis'] ?? '');
  const fieldCodeSource = `${raw['Tender / Sebutharga Adalah Dipelawa kepada'] ?? ''} ${raw['Syarat Pendaftaran'] ?? ''}`;
  const mentionsBriefing = /taklimat/i.test(fieldCodeSource);
  const events = extractLawatanTapakEvent(raw['Lawatan Tapak'], mentionsBriefing);

  const candidate = {
    dedupKey: computeDedupKey(referenceNo, fallback),
    referenceNo,
    title,
    status: ctx.status,
    procurementType,
    scrapedAt: now(),
    source: { source: SOURCE, sourceId: ctx.sourceId, sourceUrl: ctx.sourceUrl },
    agency: AGENCY,
    category: raw['Kategori'] || null,
    fieldCodes: extractFieldCodes(fieldCodeSource),
    advertisedDate: parseDottedDate(raw['Tarikh Mula Jualan Dokumen']),
    closingDate: parseIsoDatePrefix(raw['Tarikh dan Waktu Tutup']),
    events,
    raw,
  };

  const result = TenderPatchSchema.safeParse(candidate);
  if (!result.success) {
    console.warn(`[llm] skipping invalid detail page ${ctx.sourceUrl}: ${result.error.message}`);
    return null;
  }
  return result.data;
}

function extractReferenceNo(title: string): string {
  // Reference codes (e.g. "LLM/KEW/SH:9/6/2026") never contain whitespace, so capturing a single
  // contiguous token stops cleanly before the trailing description — regardless of whether that
  // description is separated by ")", " - ", or nothing at all (all three occur in real titles).
  const m = title.match(/NO\.?\s*SEBUT\s*HARGA:?\s*([^\s)]+)/i);
  return m ? clean(m[1]!) : '';
}

function inferProcurementType(jenis: string): 'tender' | 'quotation' | null {
  const v = jenis.trim().toLowerCase();
  if (v === 'tender') return 'tender';
  if (v.includes('sebut')) return 'quotation';
  return null;
}

// "Lawatan Tapak" is a free-text cell shaped like "Tarikh: DD-MM-YYYY  Tempat: <address>.  Masa: HH:MM AM/PM"
// (sometimes with an empty date/"-" address when there's no site visit). The site's "Taklimat" (briefing)
// details live only in unstructured prose elsewhere on the page and, in every real listing observed, share
// this same date/place — so rather than fragile-parsing that prose, we just relabel this one event when a
// briefing is mentioned nearby, matching what a visitor reading the page would conclude.
function extractLawatanTapakEvent(lawatanTapak: string | undefined, mentionsBriefing: boolean): TenderEvent[] {
  if (!lawatanTapak || lawatanTapak === '-') return [];

  const dateMatch = lawatanTapak.match(/Tarikh:\s*([\d-]+)/);
  const addressMatch = lawatanTapak.match(/Tempat:\s*(.*?)\s*Masa:/);
  const date = dateMatch ? parseDashedDate(dateMatch[1]) : null;
  const addressRaw = addressMatch ? clean(addressMatch[1]!) : '';
  const address = addressRaw && addressRaw !== '-' ? addressRaw : null;

  if (!date && !address) return [];

  return [{ label: mentionsBriefing ? 'Taklimat & Lawatan Tapak' : 'Lawatan Tapak', date, address }];
}

export function extractFieldCodes(text: string): string[] {
  const codes: string[] = [];
  const markerRegex = /kod\s*bidang\s*:?\s*/gi;
  const codeRegex = /^(\d{5,7})(?:\s*-\s*\([^)]*\))?\s*(?:,|atau|dan|\/)?\s*/i;
  let markerMatch: RegExpExecArray | null;

  while ((markerMatch = markerRegex.exec(text))) {
    let rest = text.slice(markerMatch.index + markerMatch[0].length);
    for (let codeMatch = rest.match(codeRegex); codeMatch; codeMatch = rest.match(codeRegex)) {
      codes.push(codeMatch[1]!);
      rest = rest.slice(codeMatch[0].length);
    }
  }

  return Array.from(new Set(codes));
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
