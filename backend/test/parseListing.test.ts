import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { TenderPatchSchema } from '@tms/shared';
import { parseListingHtml, type JobContext } from '../src/scrapers/myprocurement/parseListing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NOW = () => '2026-07-07T12:00:00.000Z';
const OPEN_Q: JobContext = { status: 'open', procurementType: 'quotation', now: NOW };

// Single card verbatim from the real API response shape (entities included), with an
// events table, so exact values can be asserted deterministically.
const CARD_HTML = `<div>
  <div x-data="{ selected: false, open: true }" class="flex flex-col">
    <div class="flex">
      <button x-on:click="selected = !selected; $dispatch('select-procurement', { id: 789195 })"></button>
    </div>
    <div class="flex-grow text-sm md:text-base break-words">
      <div>
        <div class="mx-4 px-4 py-2 inline-block rounded-md bg-primary/20">
          Tarikh Pelawaan: 07/07/2026
        </div>
        <div class="px-4 py-2 rounded-md">
          <span class="font-bold">No. Sebut Harga</span>: UTHM/54(KTKEM)/P/02/023/2026(1)
        </div>
        <div class="px-4 py-2 rounded-md text-justify font-bold text-primary uppercase">
          <a href="https://myprocurement.treasury.gov.my/advertisements/quotation/71ebb6ee">MAKMAL ELEKTRIK &amp; ELEKTRONIK 2</a>
        </div>
        <div x-show="open" class="flex flex-col w-full px-4">
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Kementerian:</div>
            <div class="w-full sm:w-2/3 uppercase">KEMENTERIAN PENDIDIKAN TINGGI</div>
          </div>
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Agensi:</div>
            <div class="w-full sm:w-2/3 uppercase">UNIVERSITI TUN HUSSEIN ONN MALAYSIA (UTHM)</div>
          </div>
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Kategori Perolehan:</div>
            <div class="w-full sm:w-2/3 uppercase">Perkhidmatan Bukan Perunding</div>
          </div>
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Kod Bidang:</div>
            <div class="w-full sm:w-2/3 uppercase">E05, E32</div>
          </div>
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Tarikh Tutup Pelawaan:</div>
            <div class="w-full sm:w-2/3 uppercase">17/07/2026</div>
          </div>
          <div class="flex flex-col sm:flex-row mt-2">
            <div class="w-full sm:w-1/3 font-bold align-top">Harga Indikatif Jabatan:</div>
            <div class="w-full sm:w-2/3 uppercase">RM 28,800.00</div>
          </div>
        </div>
        <div x-show="open" class="mt-2 w-full">
          <table class="w-full hidden md:block">
            <tr class="bg-primary/20"><th>Bil.</th><th>Perkara</th><th>Tarikh</th><th>Alamat</th></tr>
            <tr class="uppercase">
              <td>1.</td>
              <td>Lawatan Tapak</td>
              <td>10/07/2026</td>
              <td class="w-full">MAKMAL OR, BLOK A, STRIDE, KAJANG, SELANGOR</td>
            </tr>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>`;

describe('parseListingHtml — embedded card, exact values', () => {
  it('extracts every field from a card, shaped as a TenderPatch', () => {
    const [t] = parseListingHtml(CARD_HTML, OPEN_Q);
    expect(t).toBeDefined();
    expect(t!.source).toEqual({
      source: 'myprocurement', sourceId: '789195',
      sourceUrl: 'https://myprocurement.treasury.gov.my/advertisements/quotation/71ebb6ee',
    });
    expect(t!.referenceNo).toBe('UTHM/54(KTKEM)/P/02/023/2026(1)');
    expect(t!.dedupKey).toBe('UTHM/54(KTKEM)/P/02/023/2026(1)');
    expect(t!.title).toBe('MAKMAL ELEKTRIK & ELEKTRONIK 2'); // entity decoded
    expect(t!.status).toBe('open');
    expect(t!.procurementType).toBe('quotation');
    expect(t!.ministry).toBe('KEMENTERIAN PENDIDIKAN TINGGI');
    expect(t!.agency).toBe('UNIVERSITI TUN HUSSEIN ONN MALAYSIA (UTHM)');
    expect(t!.category).toBe('Perkhidmatan Bukan Perunding');
    expect(t!.fieldCodes).toEqual(['E05', 'E32']);
    expect(t!.advertisedDate).toBe('2026-07-07');
    expect(t!.closingDate).toBe('2026-07-17');
    expect(t!.indicativePrice).toBe(28800);
    expect(t!.events).toEqual([
      { label: 'Lawatan Tapak', date: '2026-07-10', address: 'MAKMAL OR, BLOK A, STRIDE, KAJANG, SELANGOR' },
    ]);
    expect(t!.raw!['No. Sebut Harga']).toBe('UTHM/54(KTKEM)/P/02/023/2026(1)');
    expect(t!.raw!['Harga Indikatif Jabatan']).toBe('RM 28,800.00');
    expect(t!.scrapedAt).toBe('2026-07-07T12:00:00.000Z');
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('tags status/procurementType from the job context, not page text', () => {
    const [t] = parseListingHtml(CARD_HTML, { status: 'closed', procurementType: 'tender', now: NOW });
    expect(t!.status).toBe('closed');
    expect(t!.procurementType).toBe('tender');
  });

  it('skips cards without a title link instead of throwing', () => {
    const broken = CARD_HTML.replace(/<a href="[^"]*">.*?<\/a>/s, '');
    expect(parseListingHtml(broken, OPEN_Q)).toEqual([]);
  });
});

describe('parseListingHtml — edge cases for branch coverage', () => {
  it('skips a card whose title link has an invalid sourceUrl instead of throwing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badUrl = CARD_HTML.replace(
      'href="https://myprocurement.treasury.gov.my/advertisements/quotation/71ebb6ee"',
      'href="/relative/not-a-full-url"',
    );
    expect(parseListingHtml(badUrl, OPEN_Q)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[myprocurement] skipping invalid card'));
    warnSpy.mockRestore();
  });

  it('ignores non-card x-data wrappers (e.g. pagination controls)', () => {
    const withPagination = `<div x-data="{ page: 1 }"><span>1</span></div>${CARD_HTML}`;
    const [t] = parseListingHtml(withPagination, OPEN_Q);
    expect(t!.source.sourceId).toBe('789195');
  });

  it('falls back to Date.now() when ctx.now is not provided', () => {
    const [t] = parseListingHtml(CARD_HTML, { status: 'open', procurementType: 'quotation' });
    expect(typeof t!.scrapedAt).toBe('string');
    expect(t!.scrapedAt.length).toBeGreaterThan(0);
  });

  it('defaults missing address to null when the address cell is empty', () => {
    const noAddress = CARD_HTML.replace(
      '<td class="w-full">MAKMAL OR, BLOK A, STRIDE, KAJANG, SELANGOR</td>',
      '<td class="w-full"></td>',
    );
    const [t] = parseListingHtml(noAddress, OPEN_Q);
    expect(t!.events![0]!.address).toBeNull();
  });

  it('falls back to the source:sourceId composite for dedupKey when referenceNo is empty', () => {
    const noRef = CARD_HTML.replace(
      '<span class="font-bold">No. Sebut Harga</span>: UTHM/54(KTKEM)/P/02/023/2026(1)',
      '<span class="font-bold">No. Sebut Harga</span>: ',
    );
    const [t] = parseListingHtml(noRef, OPEN_Q);
    expect(t!.referenceNo).toBe('');
    expect(t!.dedupKey).toBe('myprocurement:789195');
  });
});

const FIXTURES: Array<{ file: string; ctx: JobContext }> = [
  { file: 'open-quotation-p1.json', ctx: { status: 'open', procurementType: 'quotation', now: NOW } },
  { file: 'open-tender-p1.json', ctx: { status: 'open', procurementType: 'tender', now: NOW } },
  { file: 'open-requisition-p1.json', ctx: { status: 'open', procurementType: 'requisition', now: NOW } },
  { file: 'archive-quotation-p1.json', ctx: { status: 'closed', procurementType: 'quotation', now: NOW } },
];

describe('parseListingHtml — live fixtures, structural invariants', () => {
  for (const { file, ctx } of FIXTURES) {
    it(`parses every card in ${file} into schema-valid patches`, () => {
      const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', file), 'utf8'));
      const patches = parseListingHtml(raw.html, ctx);
      expect(patches.length).toBeGreaterThan(0);
      // Every select-procurement id in the HTML must yield a parsed patch: nothing missed.
      const idsInHtml = new Set([...raw.html.matchAll(/select-procurement'?,?\s*\{\s*id:\s*(\d+)/g)].map((m) => m[1]));
      expect(new Set(patches.map((t) => t.source.sourceId))).toEqual(idsInHtml);
      for (const t of patches) {
        expect(() => TenderPatchSchema.parse(t)).not.toThrow();
        expect(t.status).toBe(ctx.status);
        expect(t.procurementType).toBe(ctx.procurementType);
        if (t.advertisedDate) expect(t.advertisedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if (t.closingDate) expect(t.closingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  }
});
