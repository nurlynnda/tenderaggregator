import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseLlmListingHtml } from '../src/scrapers/llm/parseListing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ROW_HTML = `<div id="tender-table-head"><table><tbody>
  <tr class="tender-inner-header"><th>Tajuk</th></tr>
  <tr>
    <td><a href="https://www.llm.gov.my/swasta/tender_detail/12543/#tender-table-head"><header>TITLE ONE</header></a></td>
    <td>20/07/2026</td><td>14/09/2026</td><td>14/10/2026</td>
  </tr>
</tbody></table></div>`;

describe('parseLlmListingHtml — embedded row, exact values', () => {
  it('extracts sourceId and a fragment-stripped sourceUrl from a tender detail link', () => {
    const links = parseLlmListingHtml(ROW_HTML);
    expect(links).toEqual([
      { sourceId: '12543', sourceUrl: 'https://www.llm.gov.my/swasta/tender_detail/12543/' },
    ]);
  });

  it('returns an empty array when no tender detail links are present', () => {
    expect(parseLlmListingHtml('<div id="tender-table-head"><table><tbody></tbody></table></div>')).toEqual([]);
  });

  it('deduplicates repeated links to the same tender id', () => {
    const html = ROW_HTML + ROW_HTML;
    expect(parseLlmListingHtml(html)).toHaveLength(1);
  });
});

describe('parseLlmListingHtml — live fixture, structural invariants', () => {
  it('parses every tender row in the fixture into a link', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'llm-tender_tawaran.html'), 'utf8');
    const links = parseLlmListingHtml(html);
    expect(links).toHaveLength(6);
    const idsInHtml = new Set([...html.matchAll(/\/swasta\/tender_detail\/(\d+)/g)].map((m) => m[1]));
    expect(new Set(links.map((l) => l.sourceId))).toEqual(idsInHtml);
    for (const link of links) {
      expect(link.sourceUrl).toMatch(/^https:\/\/www\.llm\.gov\.my\/swasta\/tender_detail\/\d+\/$/);
    }
  });
});
