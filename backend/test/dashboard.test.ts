import { describe, expect, it } from 'vitest';
import type { Tender } from '@tms/shared';
import { buildDashboardStats } from '../src/query/dashboard.js';

let seq = 0;
function makeTender(overrides: Partial<Tender> = {}): Tender {
  seq += 1;
  return {
    dedupKey: `REF/${seq}`, referenceNo: `REF/${seq}`, title: `TENDER ${seq}`,
    status: 'closed', procurementType: 'tender',
    ministry: 'KEMENTERIAN A', agency: null, category: null, fieldCodes: [],
    advertisedDate: '2024-03-01', closingDate: '2024-03-15', indicativePrice: null,
    currency: 'MYR', events: [],
    winners: [{ name: 'ACME SDN BHD', price: 100 }],
    raw: {}, scrapedAt: '2026-07-10T00:00:00.000Z',
    sources: [{ source: 'myprocurement', sourceId: String(seq), sourceUrl: `https://example.com/${seq}` }],
    ...overrides,
  };
}

describe('buildDashboardStats', () => {
  it('returns zeros and empty lists for no tenders', () => {
    expect(buildDashboardStats([])).toEqual({
      totalAwardedValue: 0, totalAwardedCount: 0, excludedFromValueCount: 0,
      byMinistry: [], topContractors: [], byYear: [],
    });
  });

  it('counts a single awarded tender with one priced winner', () => {
    const stats = buildDashboardStats([makeTender()]);
    expect(stats.totalAwardedValue).toBe(100);
    expect(stats.totalAwardedCount).toBe(1);
    expect(stats.excludedFromValueCount).toBe(0);
    expect(stats.byMinistry).toEqual([{ ministry: 'KEMENTERIAN A', totalValue: 100, count: 1 }]);
    expect(stats.topContractors).toEqual([{ name: 'ACME SDN BHD', wins: 1, totalValue: 100 }]);
    expect(stats.byYear).toEqual([{ year: 2024, totalValue: 100 }]);
  });

  it('splits a joint award: priced winner contributes value, unpriced winner still gets a win', () => {
    const stats = buildDashboardStats([makeTender({
      winners: [{ name: 'ACME SDN BHD', price: 100 }, { name: 'BETA ENGINEERING', price: null }],
    })]);
    expect(stats.totalAwardedValue).toBe(100); // only the priced winner counts toward money
    expect(stats.excludedFromValueCount).toBe(1); // the null-price winner
    expect(stats.byMinistry).toEqual([{ ministry: 'KEMENTERIAN A', totalValue: 100, count: 1 }]);
    const acme = stats.topContractors.find((c) => c.name === 'ACME SDN BHD');
    const beta = stats.topContractors.find((c) => c.name === 'BETA ENGINEERING');
    expect(acme).toEqual({ name: 'ACME SDN BHD', wins: 1, totalValue: 100 });
    expect(beta).toEqual({ name: 'BETA ENGINEERING', wins: 1, totalValue: 0 });
  });

  it('groups a null ministry under "Unknown"', () => {
    const stats = buildDashboardStats([makeTender({ ministry: null })]);
    expect(stats.byMinistry).toEqual([{ ministry: 'Unknown', totalValue: 100, count: 1 }]);
  });

  it('uses advertisedDate for the year bucket when closingDate is missing', () => {
    const stats = buildDashboardStats([makeTender({ closingDate: null, advertisedDate: '2022-06-01' })]);
    expect(stats.byYear).toEqual([{ year: 2022, totalValue: 100 }]);
  });

  it('still counts a tender with neither date toward totals, but omits it from byYear', () => {
    const stats = buildDashboardStats([makeTender({ closingDate: null, advertisedDate: null })]);
    expect(stats.totalAwardedCount).toBe(1);
    expect(stats.totalAwardedValue).toBe(100);
    expect(stats.byYear).toEqual([]);
  });

  it('truncates to the top 10 ministries by total value, descending', () => {
    const tenders = Array.from({ length: 12 }, (_, i) => makeTender({
      ministry: `MINISTRY ${i}`,
      winners: [{ name: `CONTRACTOR ${i}`, price: (i + 1) * 1000 }],
    }));
    const stats = buildDashboardStats(tenders);
    expect(stats.byMinistry).toHaveLength(10);
    expect(stats.byMinistry[0]).toEqual({ ministry: 'MINISTRY 11', totalValue: 12000, count: 1 });
    expect(stats.byMinistry[9]).toEqual({ ministry: 'MINISTRY 2', totalValue: 3000, count: 1 });
  });

  it('truncates to the top 10 contractors by win count, descending, ties broken by value', () => {
    const many = Array.from({ length: 9 }, (_, i) => makeTender({
      winners: [{ name: `SMALL ${i}`, price: 1 }],
    }));
    const bigWinner = Array.from({ length: 3 }, () => makeTender({
      winners: [{ name: 'BIG WINNER', price: 500 }],
    }));
    const tieA = makeTender({ winners: [{ name: 'TIE A', price: 50 }] });
    const tieB = makeTender({ winners: [{ name: 'TIE B', price: 20 }] });
    const stats = buildDashboardStats([...many, ...bigWinner, tieA, tieB]);
    expect(stats.topContractors).toHaveLength(10);
    expect(stats.topContractors[0]).toEqual({ name: 'BIG WINNER', wins: 3, totalValue: 1500 });
    // TIE A and TIE B both have 1 win; TIE A's higher value must sort first
    const tieIndexA = stats.topContractors.findIndex((c) => c.name === 'TIE A');
    const tieIndexB = stats.topContractors.findIndex((c) => c.name === 'TIE B');
    expect(tieIndexA).toBeLessThan(tieIndexB);
  });

  it('does not count a closed tender with no winners as awarded', () => {
    const stats = buildDashboardStats([makeTender({ winners: null })]);
    expect(stats.totalAwardedCount).toBe(0);
    expect(stats.byMinistry).toEqual([]);
  });

  it('does not count an open tender with winners as awarded', () => {
    const stats = buildDashboardStats([makeTender({ status: 'open' })]);
    expect(stats.totalAwardedCount).toBe(0);
  });
});
