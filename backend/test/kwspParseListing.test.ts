import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TenderPatchSchema } from '@tms/shared';
import { parseOpenTenders, parseResults, parseKwspListingHtml } from '../src/scrapers/kwsp/parseListing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NOW = () => '2026-07-11T12:00:00.000Z';

const OPEN_CARD_HTML = `<div class="card-bg">
  <h4 class="component-heading"></h4>
  <h4 class="component-heading"></h4>
  <h4 class="component-heading">Cadangan Kerja-Kerja Penggantian Sistem Pam</h4>
  <div class="component-paragraph">
    <h4><span class="lead">Tender No.</span></h4>
    <ul><li><p>Doc5759801507</p></li></ul>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Qualification Criteria</span></h4>
    <div>CIDB Gred G4, M02/M15/M20/M22 and SPKK</div>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Open Date</span></h4>
    <ul><li>06.07.2026 (Monday)</li></ul>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Closing Date</span></h4>
    <ul><li><p>03.08.2026 (Monday)</p></li></ul>
  </div>
  <div class="component-paragraph">
    <h4><span class="lead">Document Price</span></h4>
    <ul><li>Free</li></ul>
  </div>
  <a href="https://forms.office.com/r/hmX89dnb0U"><h6>Apply For Tender</h6></a>
  <a href="/documents/d/guest/c-3277-kwsp-na-artwork-1"><h6>More Info</h6></a>
</div>`;

describe('parseOpenTenders — embedded card, exact values', () => {
  it('extracts every field from an open-tender card, shaped as a TenderPatch', () => {
    const [t] = parseOpenTenders(OPEN_CARD_HTML, { now: NOW });
    expect(t).toBeDefined();
    expect(t!.referenceNo).toBe('Doc5759801507');
    expect(t!.dedupKey).toBe('DOC5759801507');
    expect(t!.title).toBe('Cadangan Kerja-Kerja Penggantian Sistem Pam');
    expect(t!.status).toBe('open');
    expect(t!.procurementType).toBe('tender');
    expect(t!.agency).toBe('Kumpulan Wang Simpanan Pekerja (KWSP)');
    expect(t!.advertisedDate).toBe('2026-07-06');
    expect(t!.closingDate).toBe('2026-08-03');
    expect(t!.source).toEqual({
      source: 'kwsp',
      sourceId: 'c-3277-kwsp-na-artwork-1',
      sourceUrl: 'https://www.kwsp.gov.my/documents/d/guest/c-3277-kwsp-na-artwork-1',
    });
    expect(t!.raw!['Tender No.']).toBe('Doc5759801507');
    expect(t!.raw!['Qualification Criteria']).toBe('CIDB Gred G4, M02/M15/M20/M22 and SPKK');
    expect(t!.scrapedAt).toBe('2026-07-11T12:00:00.000Z');
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('omits ministry/category/fieldCodes/indicativePrice/events/winners entirely (not observed by this source)', () => {
    const [t] = parseOpenTenders(OPEN_CARD_HTML, { now: NOW });
    expect(t).not.toHaveProperty('ministry');
    expect(t).not.toHaveProperty('category');
    expect(t).not.toHaveProperty('fieldCodes');
    expect(t).not.toHaveProperty('indicativePrice');
    expect(t).not.toHaveProperty('events');
    expect(t).not.toHaveProperty('winners');
  });

  it('falls back to the tenders page URL when the "More Info" link is missing', () => {
    const noLink = OPEN_CARD_HTML.replace(
      '<a href="/documents/d/guest/c-3277-kwsp-na-artwork-1"><h6>More Info</h6></a>', '',
    );
    const [t] = parseOpenTenders(noLink, { now: NOW });
    expect(t!.source.sourceUrl).toBe('https://www.kwsp.gov.my/en/corporate/procurement/tenders');
    expect(t!.source.sourceId).toBe('Doc5759801507');
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('skips a card with no title instead of throwing', () => {
    const noTitle = OPEN_CARD_HTML.replace('Cadangan Kerja-Kerja Penggantian Sistem Pam', '');
    expect(parseOpenTenders(noTitle, { now: NOW })).toEqual([]);
  });

  it('skips a card with no "Tender No." field instead of throwing', () => {
    const noRef = OPEN_CARD_HTML.replace('<span class="lead">Tender No.</span>', '<span class="lead">Tender Ref</span>');
    expect(parseOpenTenders(noRef, { now: NOW })).toEqual([]);
  });

  it('excludes a Tender Results card-bg (containing an accordion-card) from open tenders', () => {
    const resultsCard = `<div class="card-bg"><div class="accordion-card"></div></div>`;
    expect(parseOpenTenders(OPEN_CARD_HTML + resultsCard, { now: NOW })).toHaveLength(1);
  });

  it('falls back to Date.now() when ctx.now is not provided', () => {
    const [t] = parseOpenTenders(OPEN_CARD_HTML);
    expect(typeof t!.scrapedAt).toBe('string');
    expect(t!.scrapedAt.length).toBeGreaterThan(0);
  });
});

const RESULTS_HTML = `<div class="card-bg">
  <div class="accordion-card">
    <div class="accordion-item">
      <div class="accordion-header"><h3>March 2026</h3></div>
      <div class="accordion-content">
        <p>Cadangan Kerja-Kerja Penggantian Pam Di EPF Learning Campus<br> <em>Doc5446704109<br> MEDIINA WAWASAN RESOURCES</em></p>
      </div>
    </div>
    <div class="accordion-item">
      <div class="accordion-header"><h3>November 2025</h3></div>
      <div class="accordion-content">
        <p>Perkhidmatan Penghantaran Khidmat Pesanan Ringkas (SMS)<br> <em>Doc5248683420<br> Maxis Broadband Sdn Bhd<br> Celcom Berhad</em></p>
      </div>
    </div>
  </div>
</div>`;

const MALFORMED_RESULT_HTML = `<div class="card-bg">
  <div class="accordion-card">
    <div class="accordion-item">
      <div class="accordion-header"><h3>March 2026</h3></div>
      <div class="accordion-content">
        <p>Title With No Reference Block At All</p>
      </div>
    </div>
  </div>
</div>`;

describe('parseResults — embedded entries, exact values', () => {
  it('extracts a single-winner result entry, shaped as a TenderPatch', () => {
    const results = parseResults(RESULTS_HTML, { now: NOW });
    const t = results.find((r) => r.referenceNo === 'Doc5446704109');
    expect(t).toBeDefined();
    expect(t!.title).toBe('Cadangan Kerja-Kerja Penggantian Pam Di EPF Learning Campus');
    expect(t!.status).toBe('closed');
    expect(t!.procurementType).toBe('tender');
    expect(t!.agency).toBe('Kumpulan Wang Simpanan Pekerja (KWSP)');
    expect(t!.dedupKey).toBe('DOC5446704109');
    expect(t!.winners).toEqual([{ name: 'MEDIINA WAWASAN RESOURCES', price: null }]);
    expect(t!.source).toEqual({
      source: 'kwsp', sourceId: 'Doc5446704109',
      sourceUrl: 'https://www.kwsp.gov.my/en/corporate/procurement/tenders',
    });
    expect(t).not.toHaveProperty('advertisedDate');
    expect(t).not.toHaveProperty('closingDate');
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('splits multiple winners on <br> within the reference/winner block', () => {
    const results = parseResults(RESULTS_HTML, { now: NOW });
    const t = results.find((r) => r.referenceNo === 'Doc5248683420');
    expect(t!.winners).toEqual([
      { name: 'Maxis Broadband Sdn Bhd', price: null },
      { name: 'Celcom Berhad', price: null },
    ]);
    expect(t).not.toHaveProperty('closingDate');
  });

  it('omits winners entirely (not []) when the reference block has no winner name', () => {
    const noWinnerName = RESULTS_HTML.replace(
      'Doc5446704109<br> MEDIINA WAWASAN RESOURCES', 'Doc5446704109',
    );
    const results = parseResults(noWinnerName, { now: NOW });
    const t = results.find((r) => r.referenceNo === 'Doc5446704109');
    expect(t).toBeDefined();
    expect(t).not.toHaveProperty('winners');
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('skips a result entry with no reference/winner block instead of throwing', () => {
    expect(parseResults(MALFORMED_RESULT_HTML, { now: NOW })).toEqual([]);
  });

  it('falls back to Date.now() when ctx.now is not provided', () => {
    const [t] = parseResults(RESULTS_HTML);
    expect(typeof t!.scrapedAt).toBe('string');
    expect(t!.scrapedAt.length).toBeGreaterThan(0);
  });
});

describe('parseOpenTenders / parseResults — kept separate in the same document', () => {
  it('does not let a Tender Results card leak into open tenders, or vice versa', () => {
    const combined = OPEN_CARD_HTML + RESULTS_HTML;
    expect(parseOpenTenders(combined, { now: NOW })).toHaveLength(1);
    expect(parseResults(combined, { now: NOW })).toHaveLength(2);
  });
});

describe('parseKwspListingHtml — live fixture, structural invariants', () => {
  it('parses every open card and result entry in the fixture into schema-valid patches', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'kwsp-tenders.html'), 'utf8');
    const { open, results } = parseKwspListingHtml(html, { now: NOW });
    expect(open).toHaveLength(2); // third card is missing "Tender No." and is skipped
    expect(results).toHaveLength(2); // the malformed entry with no <em> block is skipped

    for (const t of [...open, ...results]) {
      expect(() => TenderPatchSchema.parse(t)).not.toThrow();
      expect(t.source.source).toBe('kwsp');
      if (t.advertisedDate) expect(t.advertisedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (t.closingDate) expect(t.closingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(open.every((t) => t.status === 'open')).toBe(true);
    expect(results.every((t) => t.status === 'closed')).toBe(true);
    expect(new Set([...open, ...results].map((t) => t.dedupKey)).size).toBe(4);
  });
});
