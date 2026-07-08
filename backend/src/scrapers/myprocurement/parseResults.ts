import * as cheerio from 'cheerio';
import type { AnyNode, Cheerio } from 'cheerio';
import { TenderPatchSchema, computeDedupKey, type TenderPatch, type Winner } from '@tms/shared';
import { parseRmPrice } from '../../parsing/text.js';

export interface ResultsJobContext {
  procurementType: 'quotation' | 'tender';
  now?: () => string;
}

const SOURCE = 'myprocurement';

export function parseResultsHtml(html: string, ctx: ResultsJobContext): TenderPatch[] {
  const $ = cheerio.load(html);
  const now = ctx.now ?? (() => new Date().toISOString());
  const patches: TenderPatch[] = [];

  $('div[x-data]').each((_, el) => {
    const card = $(el);
    const xData = card.attr('x-data') ?? '';
    if (!xData.includes('selected')) return;

    const candidate = parseResultsCard($, card, ctx, now());
    if (!candidate) return;
    const result = TenderPatchSchema.safeParse(candidate);
    if (!result.success) {
      console.warn(`[myprocurement] skipping invalid results card: ${result.error.message}`);
      return;
    }
    patches.push(result.data);
  });

  return patches;
}

function parseResultsCard(
  $: cheerio.CheerioAPI,
  card: Cheerio<AnyNode>,
  ctx: ResultsJobContext,
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
  card.find('div.font-bold.align-top').each((_, labelEl) => {
    const label = clean($(labelEl).text()).replace(/:$/, '');
    const value = clean($(labelEl).next('div').text());
    if (label) raw[label] = value;
  });

  let referenceNo = '';
  card.find('span.font-bold').each((_, spanEl) => {
    const span = $(spanEl);
    const label = clean(span.text());
    if (!label.startsWith('No.')) return;
    const parentText = clean(span.parent().text());
    referenceNo = clean(parentText.slice(parentText.indexOf(label) + label.length).replace(/^:/, ''));
    raw[label] = referenceNo;
  });

  // Winner rows: the desktop table's header row has <th> cells (0 <td>s), so filtering on
  // "at least 3 <td> cells" naturally skips the header without separate detection logic.
  const winners: Winner[] = [];
  card.find('table tr').each((_, rowEl) => {
    const cells = $(rowEl).find('td');
    if (cells.length < 3) return;
    const name = clean(cells.eq(1).text());
    if (!name) return;
    winners.push({ name, price: parseRmPrice(`RM ${clean(cells.eq(2).text())}`) });
  });

  const fallback = `${SOURCE}:${sourceId}`;
  return {
    dedupKey: computeDedupKey(referenceNo, fallback),
    referenceNo,
    title,
    status: 'closed' as const,
    procurementType: ctx.procurementType,
    scrapedAt,
    source: { source: SOURCE, sourceId, sourceUrl },
    ministry: raw['Kementerian'] || null,
    agency: raw['Agensi'] || null,
    category: raw['Kategori Perolehan'] || null,
    winners,
    raw,
  };
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
