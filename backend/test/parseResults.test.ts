import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TenderPatchSchema } from '@tms/shared';
import { parseResultsHtml, type ResultsJobContext } from '../src/scrapers/myprocurement/parseResults.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = () => '2026-07-08T00:00:00.000Z';
const QUOTATION: ResultsJobContext = { procurementType: 'quotation', now: NOW };

// Real card captured from type=archive&category=results-quotation (single winner).
const SINGLE_WINNER_CARD = `<div x-data="{ selected: false, open: true }">
  <button x-on:click="$dispatch('select-procurement', { id: 980576 })"></button>
  <div class="mx-4 px-4 py-2 inline-block rounded-md bg-primary/20">Tarikh Paparan Keputusan: 01/07/2026</div>
  <div class="px-4 py-2 rounded-md"><span class="font-bold">No. Sebut Harga</span>: 52000003</div>
  <div class="font-bold text-primary uppercase">
    <a href="https://myprocurement.treasury.gov.my/archive/results-quotation/f256becbbb44e73ed436120b9b0ab381">PERKHIDMATAN SEWAAN 45 UNIT RUMAH KELUARGA</a>
  </div>
  <div class="w-full flex flex-col px-4">
    <div class="font-bold align-top">Kementerian:</div><div>KEMENTERIAN PERTAHANAN</div>
    <div class="font-bold align-top">Agensi:</div><div>TENTERA LAUT DIRAJA MALAYSIA (TLDM)</div>
    <div class="font-bold align-top">Kategori Perolehan:</div><div>Perkhidmatan Bukan Perunding</div>
  </div>
  <table>
    <tr><th>Bil.</th><th>Nama Petender Berjaya</th><th>Harga Setuju Terima (RM)</th></tr>
    <tr><td>1.</td><td>EVERLASTING LUCK SDN. BHD.</td><td>72,000.00</td></tr>
  </table>
</div>`;

// Real multi-lot winner table captured from a second results-quotation card, attached here
// to the same real card shell above to test multi-winner parsing deterministically.
const MULTI_WINNER_CARD = SINGLE_WINNER_CARD.replace(
  '<tr><td>1.</td><td>EVERLASTING LUCK SDN. BHD.</td><td>72,000.00</td></tr>',
  `<tr><td>1.</td><td>DOUBLE R ENTERPRISE</td><td>15,000.00</td></tr>
   <tr><td>2.</td><td>IMPIAN BENTARA</td><td>429,782.20</td></tr>`,
);

describe('parseResultsHtml — embedded card, exact values', () => {
  it('extracts identity fields, ministry/agency/category, and a single winner', () => {
    const [t] = parseResultsHtml(SINGLE_WINNER_CARD, QUOTATION);
    expect(t).toBeDefined();
    expect(t!.source).toEqual({
      source: 'myprocurement', sourceId: '980576',
      sourceUrl: 'https://myprocurement.treasury.gov.my/archive/results-quotation/f256becbbb44e73ed436120b9b0ab381',
    });
    expect(t!.referenceNo).toBe('52000003');
    expect(t!.dedupKey).toBe('52000003');
    expect(t!.status).toBe('closed');
    expect(t!.procurementType).toBe('quotation');
    expect(t!.ministry).toBe('KEMENTERIAN PERTAHANAN');
    expect(t!.agency).toBe('TENTERA LAUT DIRAJA MALAYSIA (TLDM)');
    expect(t!.category).toBe('Perkhidmatan Bukan Perunding');
    expect(t!.winners).toEqual([{ name: 'EVERLASTING LUCK SDN. BHD.', price: 72000 }]);
    // Fields this job never observes must be absent from the patch, not present-as-null/empty.
    expect(t!.fieldCodes).toBeUndefined();
    expect(t!.closingDate).toBeUndefined();
    expect(t!.indicativePrice).toBeUndefined();
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('parses multiple winners for a multi-lot award', () => {
    const [t] = parseResultsHtml(MULTI_WINNER_CARD, QUOTATION);
    expect(t!.winners).toEqual([
      { name: 'DOUBLE R ENTERPRISE', price: 15000 },
      { name: 'IMPIAN BENTARA', price: 429782.2 },
    ]);
  });

  it('tags procurementType from the job context (tender vs quotation)', () => {
    const [t] = parseResultsHtml(SINGLE_WINNER_CARD, { procurementType: 'tender', now: NOW });
    expect(t!.procurementType).toBe('tender');
  });

  it('skips cards without a title link instead of throwing', () => {
    const broken = SINGLE_WINNER_CARD.replace(/<a href="[^"]*">.*?<\/a>/s, '');
    expect(parseResultsHtml(broken, QUOTATION)).toEqual([]);
  });
});

describe('parseResultsHtml — live fixture, structural invariants', () => {
  it('parses every card in results-quotation-p1.json into schema-valid patches', () => {
    const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'results-quotation-p1.json'), 'utf8'));
    const patches = parseResultsHtml(raw.html, QUOTATION);
    expect(patches.length).toBeGreaterThan(0);
    const idsInHtml = new Set([...raw.html.matchAll(/select-procurement'?,?\s*\{\s*id:\s*(\d+)/g)].map((m: RegExpMatchArray) => m[1]));
    expect(new Set(patches.map((t) => t.source.sourceId))).toEqual(idsInHtml);
    for (const t of patches) {
      expect(() => TenderPatchSchema.parse(t)).not.toThrow();
      expect(t.status).toBe('closed');
      expect(t.winners!.length).toBeGreaterThan(0);
    }
  });
});
