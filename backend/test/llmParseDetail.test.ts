import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TenderPatchSchema } from '@tms/shared';
import { parseLlmDetailHtml, extractFieldCodes } from '../src/scrapers/llm/parseDetail.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = () => '2026-07-16T12:00:00.000Z';

function detailHtml(opts: {
  title: string;
  saleStart?: string;
  jenis?: string;
  kategori?: string;
  dipelawaKepada?: string;
  syaratPendaftaran?: string;
  closingDate?: string;
}): string {
  const {
    title,
    saleStart = '20.07.2026',
    jenis = 'Tender',
    kategori = 'Kerja',
    dipelawaKepada = 'Syarikat-syarikat yang berdaftar dengan SSM',
    syaratPendaftaran = '-',
    closingDate = '2026-10-14',
  } = opts;
  return `<div class="panel clear-padding" id="tender-table-head">
    <div class="panel-content" id="tender-printarea">
      <header style="font-weight: bold;">${title}<div style="float:right"><a href="#"><i class="fa fa-print"></i></a></div></header>
      <table class="tender-content"><tbody>
        <tr><td style="font-weight: bold;">Tarikh Mula Jualan Dokumen</td><td>${saleStart}</td></tr>
        <tr><td style="font-weight: bold;">Tarikh Tamat Jualan Dokumen</td><td>14.09.2026</td></tr>
        <tr><td style="font-weight: bold;">Tender / Sebutharga Adalah Dipelawa kepada</td><td>${dipelawaKepada}</td></tr>
        <tr><td style="font-weight: bold;">Jenis</td><td>${jenis}</td></tr>
        <tr><td style="font-weight: bold;">Kategori</td><td>${kategori}</td></tr>
        <tr><td style="font-weight: bold;">Syarat Pendaftaran</td><td>${syaratPendaftaran}</td></tr>
        <tr><td style="font-weight: bold;">Tarikh dan Waktu Tutup</td><td>${closingDate}</td></tr>
      </tbody></table>
    </div>
  </div>`;
}

describe('parseLlmDetailHtml — embedded page, exact values', () => {
  const ctx = { sourceId: '12543', sourceUrl: 'https://www.llm.gov.my/swasta/tender_detail/12543/', now: NOW };

  it('extracts every field from a detail page, shaped as a TenderPatch', () => {
    const html = detailHtml({ title: 'TAWARAN REQUEST FOR PROPOSAL (RFP) BAGI CADANGAN' });
    const t = parseLlmDetailHtml(html, ctx);
    expect(t).toBeDefined();
    expect(t!.source).toEqual({
      source: 'llm', sourceId: '12543',
      sourceUrl: 'https://www.llm.gov.my/swasta/tender_detail/12543/',
    });
    expect(t!.title).toBe('TAWARAN REQUEST FOR PROPOSAL (RFP) BAGI CADANGAN');
    expect(t!.status).toBe('open');
    expect(t!.procurementType).toBe('tender');
    expect(t!.agency).toBe('Lembaga Lebuhraya Malaysia (LLM)');
    expect(t!.category).toBe('Kerja');
    expect(t!.advertisedDate).toBe('2026-07-20');
    expect(t!.closingDate).toBe('2026-10-14');
    expect(t!.raw['Jenis']).toBe('Tender');
    expect(t!.scrapedAt).toBe('2026-07-16T12:00:00.000Z');
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
  });

  it('extracts a reference number from a "(NO. SEBUT HARGA: ...)" title prefix and uses it as dedupKey', () => {
    const html = detailHtml({
      title: '(NO. SEBUT HARGA: LLM/KEW/SH:9/6/2026) - SEBUT HARGA BAGI PERKHIDMATAN',
      jenis: 'Sebutharga',
    });
    const t = parseLlmDetailHtml(html, ctx);
    expect(t!.referenceNo).toBe('LLM/KEW/SH:9/6/2026');
    expect(t!.dedupKey).toBe('LLM/KEW/SH:9/6/2026');
    expect(t!.procurementType).toBe('quotation');
  });

  it('falls back dedupKey to source:sourceId when the title has no reference number', () => {
    const html = detailHtml({ title: 'TAWARAN TANPA NOMBOR RUJUKAN' });
    const t = parseLlmDetailHtml(html, ctx);
    expect(t!.referenceNo).toBe('');
    expect(t!.dedupKey).toBe('llm:12543');
  });

  it('maps an unrecognized Jenis value to procurementType null', () => {
    const html = detailHtml({ title: 'T', jenis: 'Lain-lain' });
    const t = parseLlmDetailHtml(html, ctx);
    expect(t!.procurementType).toBeNull();
  });

  it('extracts field codes mentioned inline in "Dipelawa kepada", with a description in parentheses', () => {
    const html = detailHtml({
      title: 'T',
      dipelawaKepada:
        'Pelawaan adalah terbuka kepada Syarikat Bumiputera dan Bukan Bumiputera yang berkelayakan dan ' +
        'berdaftar dengan Kementerian Kewangan Malaysia di bawah Kod Bidang: 2221302 - (Rakaman) 221304 - ' +
        '(Audio Visual) atau 221303 - (Fotografi) yang mana pendaftarannya masih berkuatkuasa.',
    });
    const t = parseLlmDetailHtml(html, ctx);
    expect(t!.fieldCodes).toEqual(['2221302', '221304', '221303']);
  });

  it('extracts a single field code with no colon and no parenthetical description', () => {
    const html = detailHtml({
      title: 'T',
      dipelawaKepada: 'Berdaftar dengan Kementerian Kewangan Malaysia (MOF) Kod Bidang 210103 Dan Sijil Pematuhan Cukai',
    });
    const t = parseLlmDetailHtml(html, ctx);
    expect(t!.fieldCodes).toEqual(['210103']);
  });

  it('also picks up field codes mentioned only in "Syarat Pendaftaran"', () => {
    const html = detailHtml({
      title: 'T',
      dipelawaKepada: 'Syarikat berdaftar dengan SSM',
      syaratPendaftaran: 'Wajib berdaftar di bawah Kod Bidang: 040101 - (Elektrik) sahaja.',
    });
    const t = parseLlmDetailHtml(html, ctx);
    expect(t!.fieldCodes).toEqual(['040101']);
  });

  it('returns an empty fieldCodes array when no "Kod Bidang" text is present', () => {
    const html = detailHtml({ title: 'T' });
    const t = parseLlmDetailHtml(html, ctx);
    expect(t!.fieldCodes).toEqual([]);
  });

  it('returns null when the page has no tender panel', () => {
    expect(parseLlmDetailHtml('<div>not a tender page</div>', ctx)).toBeNull();
  });

  it('returns null when the title is empty', () => {
    const html = detailHtml({ title: '' });
    expect(parseLlmDetailHtml(html, ctx)).toBeNull();
  });
});

describe('extractFieldCodes — unit', () => {
  it('deduplicates repeated codes across multiple "Kod Bidang" mentions', () => {
    const text = 'Kod Bidang: 040101 - (Elektrik). Sila rujuk juga Kod Bidang: 040101 - (Elektrik) di atas.';
    expect(extractFieldCodes(text)).toEqual(['040101']);
  });

  it('is case-insensitive on the "Kod Bidang" marker and separators', () => {
    const text = 'KOD BIDANG: 040101 - (Elektrik) DAN 040102 - (Mekanikal)';
    expect(extractFieldCodes(text)).toEqual(['040101', '040102']);
  });
});

describe('parseLlmDetailHtml — live fixture, structural invariants', () => {
  it('parses the captured 12540 detail page into a schema-valid patch with the single MOF field code', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'llm-tender_detail_12540.html'), 'utf8');
    const t = parseLlmDetailHtml(html, {
      sourceId: '12540',
      sourceUrl: 'https://www.llm.gov.my/swasta/tender_detail/12540/',
      now: NOW,
    });
    expect(t).toBeDefined();
    expect(() => TenderPatchSchema.parse(t)).not.toThrow();
    expect(t!.title).toBe(
      'PERKHIDMATAN LESEN PENGOPERASIAN PUSAT DATA DI LEMBAGA LEBUHRAYA MALAYSIA BAGI TEMPOH TIGA (3) TAHUN (2026-2029)',
    );
    expect(t!.procurementType).toBe('tender');
    expect(t!.category).toBe('Bekalan Perkhidmatan');
    expect(t!.fieldCodes).toEqual(['210103']);
    expect(t!.advertisedDate).toBe('2026-07-06');
    expect(t!.closingDate).toBe('2026-07-24');
  });
});
