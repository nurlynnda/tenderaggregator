import type { Tender } from '@tms/shared';

export interface TenderQuery {
  search?: string;
  ministry?: string;
  agency?: string;
  category?: string;
  status?: 'open' | 'closed';
  procurementType?: 'quotation' | 'tender' | 'requisition';
  fieldCode?: string;
  hasWinners?: boolean;
  contractor?: string;
  sortBy?: 'advertisedDate' | 'closingDate' | 'indicativePrice';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface TenderPage {
  items: Tender[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Facets {
  ministries: string[];
  agencies: string[];
  categories: string[];
  procurementTypes: string[];
  fieldCodes: string[];
}

const MAX_PAGE_SIZE = 100;

export function queryTenders(tenders: Tender[], q: TenderQuery): TenderPage {
  let items = tenders;

  if (q.search) {
    const needle = q.search.toLowerCase();
    items = items.filter(
      (t) => t.title.toLowerCase().includes(needle) || t.referenceNo.toLowerCase().includes(needle),
    );
  }
  if (q.ministry) items = items.filter((t) => t.ministry === q.ministry);
  if (q.agency) items = items.filter((t) => t.agency === q.agency);
  if (q.category) items = items.filter((t) => t.category === q.category);
  if (q.status) items = items.filter((t) => t.status === q.status);
  if (q.procurementType) items = items.filter((t) => t.procurementType === q.procurementType);
  if (q.fieldCode) items = items.filter((t) => t.fieldCodes.some((c) => c.startsWith(q.fieldCode!)));
  if (q.hasWinners) items = items.filter((t) => t.winners !== null && t.winners.length > 0);
  if (q.contractor) {
    const needle = q.contractor.toLowerCase();
    items = items.filter((t) => t.winners?.some((w) => w.name.toLowerCase().includes(needle)) ?? false);
  }

  const sortBy = q.sortBy ?? 'advertisedDate';
  const dir = (q.sortOrder ?? 'desc') === 'asc' ? 1 : -1;
  const sorted = [...items].sort((a, b) => {
    const av = a[sortBy];
    const bv = b[sortBy];
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // nulls last regardless of direction
    if (bv === null) return -1;
    return av < bv ? -dir : av > bv ? dir : 0;
  });

  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, q.pageSize ?? 20));
  return {
    items: sorted.slice((page - 1) * pageSize, page * pageSize),
    total: sorted.length,
    page,
    pageSize,
  };
}

export function buildFacets(tenders: Tender[]): Facets {
  const distinct = (vals: Array<string | null>) =>
    [...new Set(vals.filter((v): v is string => v !== null))].sort();
  return {
    ministries: distinct(tenders.map((t) => t.ministry)),
    agencies: distinct(tenders.map((t) => t.agency)),
    categories: distinct(tenders.map((t) => t.category)),
    procurementTypes: distinct(tenders.map((t) => t.procurementType)),
    fieldCodes: [...new Set(tenders.flatMap((t) => t.fieldCodes))].sort(),
  };
}
