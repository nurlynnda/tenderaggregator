import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TenderPatchSchema } from '@tms/shared';
import { parseSpanListingHtml } from '../src/scrapers/span/parseListing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = () => '2026-07-09T12:00:00.000Z';

const CARD_HTML = `<div class="table-listing">
    <a href="https://www.span.gov.my/tender/view/188">
        <h3>SPAN/BKP/PROC/STM/26(8)</h3>
        CADANGAN UNTUK MELANTIK PERUNDING BAGI PELAKSANAAN KAJIAN HALA TUJU PELAN STRATEGIK ICT (GAP ANALYSIS) SURUHANJAYA PERKHIDMATAN AIR NEGARA (SPAN) 2026-2030 SECARA SEBUT HARGA TERBUKA<br>
        Tarikh Iklan 2026-06-22<br>
        Tarikh Tutup 2026-07-06 12:00PM<br>
        Maklumat Sebutharga:
            <span class="badge badge-warning">Diiklankan</span>
                </a>
</div>`;

describe('parseSpanListingHtml — embedded card, exact values', () => {
  it('extracts every field from a card, shaped as a TenderPatch', () => {
    const [t] = parseSpanListingHtml(CARD_HTML, { now: NOW });
    expect(t).toBeDefined();
    expect(t!.source).toEqual({
      source: 'span', sourceId: '188',
      sourceUrl: 'https://www.span.gov.my/tender/view/188',
    });
    expect(t!.referenceNo).toBe('SPAN/BKP/PROC/STM/26(8)');
    expect(t!.dedupKey).toBe('SPAN/BKP/PROC/STM/26(8)');
    expect(t!.title).toBe(
      'CADANGAN UNTUK MELANTIK PERUNDING BAGI PELAKSANAAN KAJIAN HALA TUJU PELAN STRATEGIK ICT (GAP ANALYSIS) SURUHANJAYA PERKHIDMATAN AIR NEGARA (SPAN) 2026-2030 SECARA SEBUT HARGA TERBUKA',
    );
    expect(t!.status).toBe('open');
    expect(t!.procurementType).toBe('quotation');
    expect(t!.agency).toBe('Suruhanjaya Perkhidmatan Air Negara (SPAN)');
    expect(t!.advertisedDate).toBe('2026-06-22');
    expect(t!.closingDate).toBe('2026-07-06');
    expect(t!.raw!['Status']).toBe('Diiklankan');
    expect(t!.scrapedAt).toBe('2026-07-09T12:00:00.000Z');
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('maps "Selesai" and "Dibatalkan" badges to status closed', () => {
    const selesai = CARD_HTML.replace('badge-warning">Diiklankan', 'badge-info">Selesai');
    expect(parseSpanListingHtml(selesai, { now: NOW })[0]!.status).toBe('closed');
    const dibatalkan = CARD_HTML.replace('Diiklankan', 'Dibatalkan');
    expect(parseSpanListingHtml(dibatalkan, { now: NOW })[0]!.status).toBe('closed');
  });

  it('infers procurementType "tender" from a TENDER keyword in the title', () => {
    const tenderCard = CARD_HTML.replace('SECARA SEBUT HARGA TERBUKA', 'SECARA TENDER TERBUKA');
    expect(parseSpanListingHtml(tenderCard, { now: NOW })[0]!.procurementType).toBe('tender');
  });

  it('defaults procurementType to null when no recognizable keyword is present', () => {
    const noKeyword = CARD_HTML.replace('SECARA SEBUT HARGA TERBUKA', 'UNTUK KEGUNAAN SURUHANJAYA');
    const [t] = parseSpanListingHtml(noKeyword, { now: NOW });
    expect(t!.procurementType).toBeNull();
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('omits ministry/category/fieldCodes/indicativePrice/events/winners entirely (not observed by this source)', () => {
    const [t] = parseSpanListingHtml(CARD_HTML, { now: NOW });
    expect(t).not.toHaveProperty('ministry');
    expect(t).not.toHaveProperty('category');
    expect(t).not.toHaveProperty('fieldCodes');
    expect(t).not.toHaveProperty('indicativePrice');
    expect(t).not.toHaveProperty('events');
    expect(t).not.toHaveProperty('winners');
  });

  it('skips a card with no parseable href instead of throwing', () => {
    const noHref = CARD_HTML.replace('href="https://www.span.gov.my/tender/view/188"', '');
    expect(parseSpanListingHtml(noHref, { now: NOW })).toEqual([]);
  });

  it('skips a card with an empty reference number instead of throwing', () => {
    const noRef = CARD_HTML.replace('<h3>SPAN/BKP/PROC/STM/26(8)</h3>', '<h3></h3>');
    expect(parseSpanListingHtml(noRef, { now: NOW })).toEqual([]);
  });

  it('falls back to Date.now() when ctx.now is not provided', () => {
    const [t] = parseSpanListingHtml(CARD_HTML);
    expect(typeof t!.scrapedAt).toBe('string');
    expect(t!.scrapedAt.length).toBeGreaterThan(0);
  });
});

describe('parseSpanListingHtml — live fixture, structural invariants', () => {
  it('parses every card in the fixture into schema-valid patches', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'span-2026.html'), 'utf8');
    const patches = parseSpanListingHtml(html, { now: NOW });
    expect(patches).toHaveLength(5);
    const idsInHtml = new Set([...html.matchAll(/\/tender\/view\/(\d+)/g)].map((m) => m[1]));
    expect(new Set(patches.map((t) => t.source.sourceId))).toEqual(idsInHtml);
    for (const t of patches) {
      expect(() => TenderPatchSchema.parse(t)).not.toThrow();
      expect(t.source.source).toBe('span');
      if (t.advertisedDate) expect(t.advertisedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (t.closingDate) expect(t.closingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // Exactly one of the five fixture cards is cancelled ("Dibatalkan") and one is
    // completed ("Selesai") — both must be tagged closed; the other three are Diiklankan/open.
    expect(patches.filter((t) => t.status === 'closed')).toHaveLength(2);
    expect(patches.filter((t) => t.status === 'open')).toHaveLength(3);
  });
});
