import * as cheerio from 'cheerio';
import type { AnyNode, Cheerio } from 'cheerio';
import { TenderPatchSchema, computeDedupKey, type TenderPatch } from '@tms/shared';
import { parseIsoDatePrefix } from '../../parsing/text.js';

export interface SpanJobContext {
  now?: () => string;
}

const SOURCE = 'span';
const AGENCY = 'Suruhanjaya Perkhidmatan Air Negara (SPAN)';

export function parseSpanListingHtml(html: string, ctx: SpanJobContext = {}): TenderPatch[] {
  const $ = cheerio.load(html);
  const now = ctx.now ?? (() => new Date().toISOString());
  const patches: TenderPatch[] = [];

  $('div.table-listing').each((_, el) => {
    const candidate = parseCard($, $(el), now());
    if (!candidate) return;
    const result = TenderPatchSchema.safeParse(candidate);
    if (!result.success) {
      console.warn(`[span] skipping invalid card: ${result.error.message}`);
      return;
    }
    patches.push(result.data);
  });

  return patches;
}

function parseCard(
  $: cheerio.CheerioAPI,
  card: Cheerio<AnyNode>,
  scrapedAt: string,
): Record<string, unknown> | null {
  const link = card.find('a').first();
  const sourceUrl = link.attr('href') ?? '';
  const idMatch = sourceUrl.match(/\/tender\/view\/(\d+)/);
  if (!idMatch || !sourceUrl) return null;
  const sourceId = idMatch[1]!;

  const referenceNo = clean(link.find('h3').first().text());
  if (!referenceNo) return null;

  const fullText = clean(link.text());
  const afterHeading = fullText.slice(fullText.indexOf(referenceNo) + referenceNo.length);
  const titleMatch = afterHeading.match(/^(.*?)\s*Tarikh Iklan/);
  const title = clean(titleMatch ? titleMatch[1]! : '');
  if (!title) return null;

  const advertisedMatch = fullText.match(/Tarikh Iklan\s*([\d-]+)/);
  const closingMatch = fullText.match(/Tarikh Tutup\s*([\d-]+(?:\s+\d{1,2}:\d{2}[AP]M)?)/);
  const badgeText = clean(card.find('.badge').first().text());

  const status: 'open' | 'closed' = badgeText === 'Diiklankan' ? 'open' : 'closed';
  const procurementType = inferProcurementType(title);

  const raw: Record<string, string> = { 'No Sebut Harga': referenceNo, Tajuk: title, Status: badgeText };
  if (advertisedMatch) raw['Tarikh Iklan'] = advertisedMatch[1]!;
  if (closingMatch) raw['Tarikh Tutup'] = closingMatch[1]!;

  const fallback = `${SOURCE}:${sourceId}`;
  return {
    dedupKey: computeDedupKey(referenceNo, fallback),
    referenceNo,
    title,
    status,
    procurementType,
    scrapedAt,
    source: { source: SOURCE, sourceId, sourceUrl },
    agency: AGENCY,
    advertisedDate: advertisedMatch ? parseIsoDatePrefix(advertisedMatch[1]) : null,
    closingDate: closingMatch ? parseIsoDatePrefix(closingMatch[1]) : null,
    raw,
  };
}

function inferProcurementType(title: string): 'quotation' | 'tender' | null {
  if (/TENDER/i.test(title)) return 'tender';
  if (/SEBUT\s*HARGA/i.test(title)) return 'quotation';
  return null;
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
