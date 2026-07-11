import * as cheerio from 'cheerio';
import type { AnyNode, Cheerio } from 'cheerio';
import type { Winner } from '@tms/shared';
import { parseRmPrice } from '../../parsing/text.js';

const NAME_LABEL = 'Nama Pembekal';
const PRICE_LABEL = 'Harga Tawaran';

export function parseSpanDetailWinners(html: string): Winner[] {
  const $ = cheerio.load(html);
  const winners: Winner[] = [];

  $('tr').each((_, rowEl) => {
    const cells = $(rowEl).find('td');
    const nameIdx = findCellIndex($, cells, NAME_LABEL);
    const priceIdx = findCellIndex($, cells, PRICE_LABEL);
    if (nameIdx === -1 || priceIdx === -1) return;

    const name = valueAfter($, cells, nameIdx);
    const price = parseRmPrice(valueAfter($, cells, priceIdx));
    if (!name || price === null) return;

    winners.push({ name, price });
  });

  return winners;
}

function findCellIndex($: cheerio.CheerioAPI, cells: Cheerio<AnyNode>, label: string): number {
  for (let i = 0; i < cells.length; i += 1) {
    if (clean($(cells[i]).text()) === label) return i;
  }
  return -1;
}

function valueAfter($: cheerio.CheerioAPI, cells: Cheerio<AnyNode>, labelIdx: number): string {
  for (let i = labelIdx + 1; i < cells.length; i += 1) {
    const text = clean($(cells[i]).text());
    if (text === '' || text === ':') continue;
    return text;
  }
  return '';
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
