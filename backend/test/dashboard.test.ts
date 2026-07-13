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
      allMinistries: [], allContractors: [],
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

  it('merges contractor winners whose names differ only by case, whitespace, or a trailing period', () => {
    const stats = buildDashboardStats([
      makeTender({ winners: [{ name: 'AIM CONCEPT SDN. BHD.', price: 428000000 }] }),
      makeTender({ winners: [{ name: 'AIM CONCEPT SDN. BHD.', price: 579777774.61 }] }),
      makeTender({ winners: [{ name: 'AIM CONCEPT SDN. BHD', price: 383040113.49 }] }),
      makeTender({ winners: [{ name: '  aim concept sdn. bhd.  ', price: 1 }] }),
    ]);
    const matches = stats.allContractors.filter((c) => c.name.toUpperCase().includes('AIM CONCEPT'));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      name: 'AIM CONCEPT SDN. BHD',
      wins: 4,
      totalValue: 428000000 + 579777774.61 + 383040113.49 + 1,
    });
  });

  it('groups a null ministry under "Unknown"', () => {
    const stats = buildDashboardStats([makeTender({ ministry: null })]);
    expect(stats.byMinistry).toEqual([{ ministry: 'Unknown', totalValue: 100, count: 1 }]);
  });

  it('uses advertisedDate for the year bucket when closingDate is missing', () => {
    const stats = buildDashboardStats([makeTender({ closingDate: null, advertisedDate: '2023-06-01' })]);
    expect(stats.byYear).toEqual([{ year: 2023, totalValue: 100 }]);
  });

  it('excludes years before 2023 from byYear', () => {
    const early = [2017, 2018, 2019, 2020, 2021, 2022].map((year) => makeTender({
      closingDate: `${year}-06-01`, winners: [{ name: 'ACME SDN BHD', price: 50 }],
    }));
    const recent = makeTender({ closingDate: '2023-06-01', winners: [{ name: 'ACME SDN BHD', price: 100 }] });
    const stats = buildDashboardStats([...early, recent]);
    expect(stats.byYear).toEqual([{ year: 2023, totalValue: 100 }]);
    // still counted toward overall totals even though excluded from the year breakdown
    expect(stats.totalAwardedCount).toBe(7);
    expect(stats.totalAwardedValue).toBe(400);
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
    expect(stats.allMinistries).toHaveLength(12);
    expect(stats.allMinistries[0]).toEqual({ ministry: 'MINISTRY 11', totalValue: 12000, count: 1 });
    expect(stats.allMinistries[11]).toEqual({ ministry: 'MINISTRY 0', totalValue: 1000, count: 1 });
  });

  it('truncates to the top 10 contractors by total value won, descending, ties broken by win count', () => {
    const many = Array.from({ length: 9 }, (_, i) => makeTender({
      winners: [{ name: `SMALL ${i}`, price: 1 }],
    }));
    const bigEarner = makeTender({ winners: [{ name: 'BIG EARNER', price: 500 }] });
    const tieManyWins = Array.from({ length: 2 }, () => makeTender({
      winners: [{ name: 'TIE MANY WINS', price: 10 }],
    }));
    const tieFewWins = makeTender({ winners: [{ name: 'TIE FEW WINS', price: 20 }] });
    const stats = buildDashboardStats([...many, bigEarner, ...tieManyWins, tieFewWins]);
    expect(stats.topContractors).toHaveLength(10);
    expect(stats.topContractors[0]).toEqual({ name: 'BIG EARNER', wins: 1, totalValue: 500 });
    // TIE MANY WINS and TIE FEW WINS both have totalValue 20; more wins must sort first
    const tieIndexMany = stats.topContractors.findIndex((c) => c.name === 'TIE MANY WINS');
    const tieIndexFew = stats.topContractors.findIndex((c) => c.name === 'TIE FEW WINS');
    expect(tieIndexMany).toBeLessThan(tieIndexFew);
    expect(stats.allContractors).toHaveLength(12);
    expect(stats.allContractors[0]).toEqual({ name: 'BIG EARNER', wins: 1, totalValue: 500 });
    const allTieIndexMany = stats.allContractors.findIndex((c) => c.name === 'TIE MANY WINS');
    const allTieIndexFew = stats.allContractors.findIndex((c) => c.name === 'TIE FEW WINS');
    expect(allTieIndexMany).toBeLessThan(allTieIndexFew);
  });

  it('does not count a closed tender with no winners as awarded', () => {
    const stats = buildDashboardStats([makeTender({ winners: null })]);
    expect(stats.totalAwardedCount).toBe(0);
    expect(stats.byMinistry).toEqual([]);
  });

  it('does not count a closed tender with an empty winners array as awarded', () => {
    const stats = buildDashboardStats([makeTender({ winners: [] })]);
    expect(stats.totalAwardedCount).toBe(0);
    expect(stats.byMinistry).toEqual([]);
  });

  it('does not count an open tender with winners as awarded', () => {
    const stats = buildDashboardStats([makeTender({ status: 'open' })]);
    expect(stats.totalAwardedCount).toBe(0);
  });
});
