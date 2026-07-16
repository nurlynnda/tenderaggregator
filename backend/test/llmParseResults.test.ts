import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseLlmResultsHtml } from '../src/scrapers/llm/parseResults.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resultRowHtml(opts: { id: number; contractor: string; nilai: string }): string {
  return `<div id="tender-table-head"><table><tbody>
  <tr class="tender-inner-header"><th>Tajuk</th><th>Kontraktor</th><th>Nilai</th></tr>
  <tr>
    <td><a href="\n            https://www.llm.gov.my/swasta/tender_detail/${opts.id}#tender-table-head">
      <header>TITLE ${opts.id}</header></a></td>
    <td style="font-weight: bold;">${opts.contractor}</td>
    <td style="font-weight: bold;">${opts.nilai}</td>
  </tr>
</tbody></table></div>`;
}

describe('parseLlmResultsHtml — embedded row, exact values', () => {
  it('extracts sourceId, a fragment-and-whitespace-stripped sourceUrl, and the winner', () => {
    const html = resultRowHtml({ id: 12526, contractor: "D'FA PRINT SDN BHD", nilai: 'RM 62180.00' });
    const rows = parseLlmResultsHtml(html);
    expect(rows).toEqual([
      {
        sourceId: '12526',
        sourceUrl: 'https://www.llm.gov.my/swasta/tender_detail/12526',
        winner: { name: "D'FA PRINT SDN BHD", price: 62180 },
      },
    ]);
  });

  it('returns winner: null when the contractor cell is empty', () => {
    const html = resultRowHtml({ id: 1, contractor: '', nilai: '' });
    const rows = parseLlmResultsHtml(html);
    expect(rows[0]!.winner).toBeNull();
  });

  it('returns an empty array when no tender rows are present', () => {
    expect(parseLlmResultsHtml('<div id="tender-table-head"><table><tbody></tbody></table></div>')).toEqual([]);
  });
});

describe('parseLlmResultsHtml — live fixture, structural invariants', () => {
  it('parses every result row in the fixture, each with a winner', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'llm-tender_keputusan.html'), 'utf8');
    const rows = parseLlmResultsHtml(html);
    expect(rows).toHaveLength(6);
    const idsInHtml = new Set([...html.matchAll(/\/swasta\/tender_detail\/(\d+)/g)].map((m) => m[1]));
    expect(new Set(rows.map((r) => r.sourceId))).toEqual(idsInHtml);
    for (const row of rows) {
      expect(row.winner).not.toBeNull();
      expect(row.winner!.name.length).toBeGreaterThan(0);
      expect(row.winner!.price).toBeGreaterThan(0);
    }
  });
});
