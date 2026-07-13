import type { Tender } from '@tms/shared';

export interface MinistryStat {
  ministry: string;
  totalValue: number;
  count: number;
}

export interface ContractorStat {
  name: string;
  wins: number;
  totalValue: number;
}

export interface YearStat {
  year: number;
  totalValue: number;
}

export interface DashboardStats {
  totalAwardedValue: number;
  totalAwardedCount: number;
  excludedFromValueCount: number;
  byMinistry: MinistryStat[];
  topContractors: ContractorStat[];
  byYear: YearStat[];
  allMinistries: MinistryStat[];
  allContractors: ContractorStat[];
}

function isAwarded(t: Tender): boolean {
  return t.status === 'closed' && t.winners !== null && t.winners.length > 0;
}

export function buildDashboardStats(tenders: Tender[]): DashboardStats {
  const awarded = tenders.filter(isAwarded);

  let totalAwardedValue = 0;
  let excludedFromValueCount = 0;
  const ministryMap = new Map<string, MinistryStat>();
  const contractorMap = new Map<string, ContractorStat>();
  const yearMap = new Map<number, YearStat>();

  for (const t of awarded) {
    const ministryKey = t.ministry ?? 'Unknown';
    const ministryStat = ministryMap.get(ministryKey) ?? { ministry: ministryKey, totalValue: 0, count: 0 };
    ministryStat.count += 1;
    ministryMap.set(ministryKey, ministryStat);

    const dateStr = t.closingDate ?? t.advertisedDate;
    const year = dateStr ? Number(dateStr.slice(0, 4)) : null;
    let yearStat: YearStat | null = null;
    if (year !== null) {
      yearStat = yearMap.get(year) ?? { year, totalValue: 0 };
      yearMap.set(year, yearStat);
    }

    for (const winner of t.winners ?? []) {
      const contractorStat = contractorMap.get(winner.name) ?? { name: winner.name, wins: 0, totalValue: 0 };
      contractorStat.wins += 1;
      contractorMap.set(winner.name, contractorStat);

      if (winner.price === null) {
        excludedFromValueCount += 1;
        continue;
      }

      contractorStat.totalValue += winner.price;
      ministryStat.totalValue += winner.price;
      totalAwardedValue += winner.price;
      if (yearStat) yearStat.totalValue += winner.price;
    }
  }

  const allMinistries = [...ministryMap.values()].sort((a, b) => b.totalValue - a.totalValue);
  const allContractors = [...contractorMap.values()]
    .sort((a, b) => (b.totalValue - a.totalValue) || (b.wins - a.wins));
  const byMinistry = allMinistries.slice(0, 10);
  const topContractors = allContractors.slice(0, 10);
  const byYear = [...yearMap.values()].sort((a, b) => a.year - b.year);

  return {
    totalAwardedValue,
    totalAwardedCount: awarded.length,
    excludedFromValueCount,
    byMinistry,
    topContractors,
    byYear,
    allMinistries,
    allContractors,
  };
}
