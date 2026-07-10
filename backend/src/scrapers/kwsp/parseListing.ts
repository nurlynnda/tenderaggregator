import * as cheerio from 'cheerio';
import type { AnyNode, Cheerio } from 'cheerio';
import { TenderPatchSchema, computeDedupKey, type TenderPatch } from '@tms/shared';
import { parseDottedDate } from '../../parsing/text.js';

export interface KwspParseContext {
  now?: () => string;
}

const SOURCE = 'kwsp';
const AGENCY = 'Kumpulan Wang Simpanan Pekerja (KWSP)';
const PAGE_URL = 'https://www.kwsp.gov.my/en/corporate/procurement/tenders';

export function parseOpenTenders(html: string, ctx: KwspParseContext = {}): TenderPatch[] {
  const $ = cheerio.load(html);
  const now = ctx.now ?? (() => new Date().toISOString());
  const scrapedAt = now();
  const patches: TenderPatch[] = [];

  $('div.card-bg').each((_, el) => {
    const card = $(el);
    if (card.find('.accordion-card').length > 0) return; // a Tender Results card, not an open tender
    const candidate = parseOpenCard($, card, scrapedAt);
    if (!candidate) return;
    const result = TenderPatchSchema.safeParse(candidate);
    if (!result.success) {
      console.warn(`[kwsp] skipping invalid open tender card: ${result.error.message}`);
      return;
    }
    patches.push(result.data);
  });

  return patches;
}

function parseOpenCard(
  $: cheerio.CheerioAPI,
  card: Cheerio<AnyNode>,
  scrapedAt: string,
): Record<string, unknown> | null {
  const title = clean(
    card.find('h4.component-heading').filter((_, h) => clean($(h).text()).length > 0).first().text(),
  );
  if (!title) return null;

  const referenceNo = fieldValue($, card, 'Tender No.');
  if (!referenceNo) return null;

  const qualificationCriteria = fieldValue($, card, 'Qualification Criteria');
  const openDateText = fieldValue($, card, 'Open Date');
  const closingDateText = fieldValue($, card, 'Closing Date');
  const documentPrice = fieldValue($, card, 'Document Price');

  const moreInfoLink = card.find('a').filter((_, a) => clean($(a).text()) === 'More Info').first();
  const href = moreInfoLink.attr('href') ?? '';
  const sourceUrl = href ? new URL(href, PAGE_URL).toString() : PAGE_URL;
  const sourceId = href.split('/').filter((seg) => seg.length > 0).pop() ?? referenceNo;

  const raw: Record<string, string> = { 'Tender No.': referenceNo, Title: title };
  if (qualificationCriteria) raw['Qualification Criteria'] = qualificationCriteria;
  if (openDateText) raw['Open Date'] = openDateText;
  if (closingDateText) raw['Closing Date'] = closingDateText;
  if (documentPrice) raw['Document Price'] = documentPrice;

  const fallback = `${SOURCE}:${sourceId}`;
  return {
    dedupKey: computeDedupKey(referenceNo, fallback),
    referenceNo,
    title,
    status: 'open',
    procurementType: 'tender',
    scrapedAt,
    source: { source: SOURCE, sourceId, sourceUrl },
    agency: AGENCY,
    advertisedDate: parseDottedDate(openDateText),
    closingDate: parseDottedDate(closingDateText),
    raw,
  };
}

function fieldValue($: cheerio.CheerioAPI, card: Cheerio<AnyNode>, label: string): string {
  const container = card.find('.component-paragraph').filter(
    (_, el) => clean($(el).find('.lead').first().text()) === label,
  ).first();
  if (container.length === 0) return '';
  const clone = container.clone();
  clone.find('h4').remove();
  return clean(clone.text());
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
