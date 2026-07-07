import * as cheerio from 'cheerio';
import type { AnyNode, Cheerio } from 'cheerio';
import { TenderSchema, computeDedupKey, type Tender, type TenderEvent } from '@tms/shared';
import { parseDdMmYyyy, parseRmPrice, splitFieldCodes } from '../../parsing/text.js';

export interface JobContext {
  status: 'open' | 'closed';
  procurementType: 'quotation' | 'tender' | 'requisition';
  now?: () => string;
}

const SOURCE = 'myprocurement';

export function parseListingHtml(html: string, ctx: JobContext): Tender[] {
  const $ = cheerio.load(html);
  const now = ctx.now ?? (() => new Date().toISOString());
  const tenders: Tender[] = [];

  $('div[x-data]').each((_, el) => {
    const card = $(el);
    const xData = card.attr('x-data') ?? '';
    if (!xData.includes('selected')) return; // pagination wrapper etc.

    const candidate = parseCard($, card, ctx, now());
    if (!candidate) return;
    const result = TenderSchema.safeParse(candidate);
    if (!result.success) {
      console.warn(`[myprocurement] skipping invalid card: ${result.error.message}`);
      return;
    }
    tenders.push(result.data);
  });

  return tenders;
}

function parseCard(
  $: cheerio.CheerioAPI,
  card: Cheerio<AnyNode>,
  ctx: JobContext,
  scrapedAt: string,
): Record<string, unknown> | null {
  const idMatch = card.html()?.match(/select-procurement'?,?\s*\{\s*id:\s*(\d+)/);
  if (!idMatch) return null;
  const sourceId = idMatch[1]!;

  const link = card.find('div.font-bold.text-primary a').first();
  const title = clean(link.text());
  const sourceUrl = link.attr('href') ?? '';
  if (!title || !sourceUrl) return null;

  const raw: Record<string, string> = {};

  // Label/value detail rows: <div class="... font-bold align-top">Label:</div><div>Value</div>
  card.find('div.font-bold.align-top').each((_, labelEl) => {
    const label = clean($(labelEl).text()).replace(/:$/, '');
    const value = clean($(labelEl).next('div').text());
    if (label) raw[label] = value;
  });

  // Reference number row: <span class="font-bold">No. Sebut Harga</span>: VALUE
  let referenceNo = '';
  card.find('span.font-bold').each((_, spanEl) => {
    const span = $(spanEl);
    const label = clean(span.text());
    if (!label.startsWith('No.')) return;
    const parentText = clean(span.parent().text());
    referenceNo = clean(parentText.slice(parentText.indexOf(label) + label.length).replace(/^:/, ''));
    raw[label] = referenceNo;
  });

  // Advertised date badge: "Tarikh Pelawaan: 07/07/2026"
  const badgeMatch = card.text().match(/Tarikh Pelawaan:\s*([\d/]+)/);
  if (badgeMatch) raw['Tarikh Pelawaan'] = badgeMatch[1]!;

  // Events from the desktop table: Bil. | Perkara | Tarikh | Alamat
  const events: TenderEvent[] = [];
  card.find('table tr').each((_, rowEl) => {
    const cells = $(rowEl).find('td');
    if (cells.length < 4) return;
    events.push({
      label: clean(cells.eq(1).text()),
      date: parseDdMmYyyy(clean(cells.eq(2).text())),
      address: clean(cells.eq(3).text()) || null,
    });
  });

  const id = `${SOURCE}:${sourceId}`;
  return {
    id,
    source: SOURCE,
    sourceId,
    referenceNo,
    dedupKey: computeDedupKey(referenceNo, id),
    title,
    sourceUrl,
    status: ctx.status,
    procurementType: ctx.procurementType,
    ministry: raw['Kementerian'] || null,
    agency: raw['Agensi'] || null,
    category: raw['Kategori Perolehan'] || null,
    fieldCodes: splitFieldCodes(raw['Kod Bidang']),
    advertisedDate: parseDdMmYyyy(raw['Tarikh Pelawaan']),
    closingDate: parseDdMmYyyy(raw['Tarikh Tutup Pelawaan']),
    indicativePrice: parseRmPrice(raw['Harga Indikatif Jabatan']),
    currency: 'MYR' as const,
    events,
    raw,
    scrapedAt,
  };
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
