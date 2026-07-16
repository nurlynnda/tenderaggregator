import * as cheerio from 'cheerio';
import type { Winner } from '@tms/shared';
import { parseRmPrice } from '../../parsing/text.js';

export interface LlmResultRow {
  sourceId: string;
  sourceUrl: string;
  winner: Winner | null;
}

export function parseLlmResultsHtml(html: string): LlmResultRow[] {
  const $ = cheerio.load(html);
  const rows: LlmResultRow[] = [];
  const seen = new Set<string>();

  $('#tender-table-head table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;

    const href = ($(cells[0]).find('a').attr('href') ?? '').trim();
    const hrefNoFragment = href.split('#')[0]!.trim();
    const idMatch = hrefNoFragment.match(/\/swasta\/tender_detail\/(\d+)\/?/);
    if (!idMatch) return;
    const sourceId = idMatch[1]!;
    if (seen.has(sourceId)) return;
    seen.add(sourceId);

    const name = clean($(cells[1]).text());
    const price = parseRmPrice(clean($(cells[2]).text()));
    const winner: Winner | null = name.length > 0 ? { name, price } : null;

    rows.push({ sourceId, sourceUrl: hrefNoFragment, winner });
  });

  return rows;
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
