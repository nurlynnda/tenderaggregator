import * as cheerio from 'cheerio';
import { TenderPatchSchema, computeDedupKey, type TenderPatch } from '@tms/shared';
import { parseDottedDate, parseIsoDatePrefix } from '../../parsing/text.js';

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
