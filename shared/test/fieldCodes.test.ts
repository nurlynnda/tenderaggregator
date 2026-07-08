import { describe, expect, it } from 'vitest';
import { FIELD_CODE_TREE, fieldCodeMatchesPrefix, flattenFieldCodes } from '../src/fieldCodes.js';

describe('FIELD_CODE_TREE', () => {
  it('has exactly 16 top-level categories', () => {
    expect(FIELD_CODE_TREE).toHaveLength(16);
    expect(FIELD_CODE_TREE.map((n) => n.code)).toEqual([
      '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '21', '22',
    ]);
  });

  it('computes full concatenated codes at every level', () => {
    const cat22 = FIELD_CODE_TREE.find((n) => n.code === '22')!;
    expect(cat22.name).toBe('Perkhidmatan');
    const sub08 = cat22.children.find((n) => n.code === '2208')!;
    expect(sub08.name).toBe('Pertahanan Dan Keselamatan');
    const leaf01 = sub08.children.find((n) => n.code === '220801')!;
    expect(leaf01.name).toBe('Kawalan Keselamatan (Perlu lesen KDN)');
  });

  it('matches the PDF changelog cross-check examples (222501, 040103)', () => {
    const flat = flattenFieldCodes();
    expect(flat.find((n) => n.code === '222501')?.name).toBe('Hotel/ Resort (Perlu Sijil Pendaftaran Premis Penginapan bawah Akta Industri Pelancongan 1992 MOTAC dan Lesen PBT)');
    expect(flat.find((n) => n.code === '040103')?.name).toBe('Makanan Bermasak (Islam)');
  });

  it('has no duplicate leaf (6-digit) codes', () => {
    const leafCodes = flattenFieldCodes().filter((n) => n.code.length === 6).map((n) => n.code);
    expect(new Set(leafCodes).size).toBe(leafCodes.length);
    expect(leafCodes.length).toBe(428);
  });
});

describe('flattenFieldCodes', () => {
  it('includes every level (main/sub/leaf) with its full path of names', () => {
    const flat = flattenFieldCodes();
    const leaf = flat.find((n) => n.code === '220801')!;
    expect(leaf.path).toEqual(['Perkhidmatan', 'Pertahanan Dan Keselamatan', 'Kawalan Keselamatan (Perlu lesen KDN)']);
  });
});

describe('fieldCodeMatchesPrefix', () => {
  it('matches a broader category code against a narrower tender code', () => {
    expect(fieldCodeMatchesPrefix('220801', '22')).toBe(true);
    expect(fieldCodeMatchesPrefix('220801', '2208')).toBe(true);
    expect(fieldCodeMatchesPrefix('220801', '220801')).toBe(true);
  });
  it('does not match an unrelated code', () => {
    expect(fieldCodeMatchesPrefix('220801', '21')).toBe(false);
    expect(fieldCodeMatchesPrefix('010101', '22')).toBe(false);
  });
});
