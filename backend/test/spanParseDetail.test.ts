import { describe, expect, it } from 'vitest';
import { parseSpanDetailWinners } from '../src/scrapers/span/parseDetail.js';

// Real winner block from span.gov.my/tender/view/147 (captured 2026-07-11), trimmed to
// two of the four "all bidders" rows plus the full KEPUTUSAN (result) winner table — the
// bidder rows prove those don't get mistaken for winner rows.
const ADJACENT_CELLS_WITH_BIDDER_TABLE = `<table cellspacing="0" cellpadding="0" style="margin:20px"><tbody>
<tr style="mso-yfti-irow:0;mso-yfti-firstrow:yes">
  <td width="230" style="border:1px solid black;text-align:center;font-weight:bold;font-size:16px">Kod Penyebut Harga</td>
  <td width="197" style="border:1px solid black;text-align:center;font-weight:bold;font-size:16px">Kos</td>
<td width="197" style="border:1px solid black;text-align:center;font-weight:bold;font-size:16px">Tempoh</td>
 </tr>
 <tr style="mso-yfti-irow:1;height:13.15pt">
  <td style="border:1px solid black;text-align:center;font-size:16px">Petender 1/4</td>
  <td style="border:1px solid black;text-align:center;font-size:16px">RM150,377.47</td>
  <td style="border:1px solid black;text-align:center;font-size:16px">12 BULAN</td>
 </tr>
<tr style="mso-yfti-irow:1;height:13.15pt">
  <td style="border:1px solid black;text-align:center;font-size:16px">Petender 2/4</td>
  <td style="border:1px solid black;text-align:center;font-size:16px">RM150,660.00</td>
  <td style="border:1px solid black;text-align:center;font-size:16px">12 BULAN</td>
 </tr></tbody></table>

<h3>KEPUTUSAN</h3>

<h3 style="border:none">MAKLUMAT PEMBEKAL YANG BERJAYA</h3>

<table border="1" style="border:1px solid black" width="100%">
<tbody>
<tr>
<td style="padding:10px;font-weight:bold">Nama Pembekal</td>
<td style="padding:10px;font-weight:bold"><p class="MsoNormal" align="center" style="text-align:center;line-height:16.0pt;
mso-line-height-rule:exactly">UMPSA SERVICES SDN BHD</p></td>
<td style="padding:10px;font-weight:bold">Harga Tawaran</td>
<td style="padding:10px;font-weight:bold"><b><span lang="EN-US" style="font-size:11.0pt;
line-height:115%;font-family:" arial",sans-serif;mso-fareast-font-family:calibri;="" mso-fareast-theme-font:minor-latin;mso-ansi-language:en-us;mso-fareast-language:="" en-us;mso-bidi-language:ar-sa"="">RM132,192.00</span></b><br></td>
</tr>
<tr>
<td style="padding:10px;font-weight:bold">Tarikh Mula Kontrak</td>
<td style="padding:10px;font-weight:bold">-</td>
<td style="padding:10px;font-weight:bold">Tarikh Tamat Kontrak</td>
<td style="padding:10px;font-weight:bold">-</td>
</tr></tbody></table>`;

// Real winner block from span.gov.my/tender/view/100 (captured 2026-07-11) — a different
// layout where name/price are separated from their label by a ":" cell.
const COLON_SEPARATED_CELLS = `<table class="table table-bordered" style="width: 748px; margin-bottom: 1rem; border-color: rgb(238, 238, 238); line-height: 19px;"><tbody><tr style="border: 1px solid rgb(238, 238, 238);"><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">MAKLUMAT PEMBEKAL YANG BERJAYA</td></tr></tbody></table><table class="table table-bordered" style="width: 748px; margin-bottom: 1rem; border-color: rgb(238, 238, 238); line-height: 19px;"><tbody><tr style="border: 1px solid rgb(238, 238, 238);"><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">Nama Pembekal</td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;"><div align="center">:</div></td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;"><p style="margin-bottom: 15px;">RANHILL CONSULTING SDN BHD</p></td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">Harga Tawaran</td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;"><div align="center">:</div></td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">RM1,285,996.03</td></tr><tr style="border: 1px solid rgb(238, 238, 238);"><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">Tarikh Mula Kontrak</td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;"><div align="center">:</div></td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">TBI</td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">Tarikh Tamat Kontrak</td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;"><div align="center">:</div></td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 1.53846;">TBI</td></tr></tbody></table>`;

// Real winner block from span.gov.my/tender/view/5 (captured 2026-07-11) — the "Nama
// Pembekal" value is the placeholder "SEBUTHARGA DITANGGUHKAN" (quotation postponed),
// not a company name, and there is no "Harga Tawaran" cell anywhere in the row.
const POSTPONED_PLACEHOLDER = `<table border="0" width="100%" style="border: 1px solid rgb(238, 238, 238); max-width: 100%;"><tbody><tr style="border: 1px solid rgb(238, 238, 238);"><td>MAKLUMAT PEMBEKAL YANG BERJAYA</td></tr></tbody></table><table class="table table-bordered" style="width: 1110px; margin-bottom: 1rem; border-color: rgb(238, 238, 238); line-height: 19px;"><tbody><tr style="border: 1px solid rgb(238, 238, 238);"><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 16px;">Nama Pembekal</td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 16px;"><div align="center">:</div></td><td colspan="4" rowspan="2" style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 16px;"><p style="margin-bottom: 15px;">SEBUTHARGA DITANGGUHKAN</p></td></tr><tr style="border: 1px solid rgb(238, 238, 238);"><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 16px;">Tarikh Mula Kontrak</td><td style="padding: 0.75rem; vertical-align: top; border-color: rgb(222, 226, 230); line-height: 16px;"><div align="center">:</div></td></tr></tbody></table>`;

// Real content from span.gov.my/tender/view/40 (captured 2026-07-11) — a cancelled
// tender with no table at all, just a plain-text notice.
const CANCELLED_NO_TABLE = `<p>Dibatalkan <br>*Sebutharga terbatal dan akan dilakukan semula<br></p>`;

describe('parseSpanDetailWinners', () => {
  it('extracts a winner from adjacent name/price cells, ignoring the all-bidders cost table', () => {
    expect(parseSpanDetailWinners(ADJACENT_CELLS_WITH_BIDDER_TABLE)).toEqual([
      { name: 'UMPSA SERVICES SDN BHD', price: 132192 },
    ]);
  });

  it('extracts a winner when name/price cells are separated by a ":" cell', () => {
    expect(parseSpanDetailWinners(COLON_SEPARATED_CELLS)).toEqual([
      { name: 'RANHILL CONSULTING SDN BHD', price: 1285996.03 },
    ]);
  });

  it('returns no winners for a postponed placeholder with no Harga Tawaran cell', () => {
    expect(parseSpanDetailWinners(POSTPONED_PLACEHOLDER)).toEqual([]);
  });

  it('returns no winners for a cancelled tender with no table at all', () => {
    expect(parseSpanDetailWinners(CANCELLED_NO_TABLE)).toEqual([]);
  });

  it('returns no winners for empty or unrelated html, without throwing', () => {
    expect(parseSpanDetailWinners('')).toEqual([]);
    expect(parseSpanDetailWinners('<p>not a tender page</p>')).toEqual([]);
  });

  it('parses multiple winners when multiple matching rows are present (multi-lot award)', () => {
    const multiLot = `<table><tbody>
<tr><td>Nama Pembekal</td><td>ALPHA ENGINEERING SDN BHD</td><td>Harga Tawaran</td><td>RM50,000.00</td></tr>
</tbody></table>
<table><tbody>
<tr><td>Nama Pembekal</td><td>BETA CONSTRUCTION SDN BHD</td><td>Harga Tawaran</td><td>RM75,500.50</td></tr>
</tbody></table>`;
    expect(parseSpanDetailWinners(multiLot)).toEqual([
      { name: 'ALPHA ENGINEERING SDN BHD', price: 50000 },
      { name: 'BETA CONSTRUCTION SDN BHD', price: 75500.5 },
    ]);
  });
});
