import type { Tender } from '@tms/shared';

export interface TenderQuery {
  search?: string;
  ministry?: string;
  agency?: string;
  category?: string;
  source?: string;
  status?: 'open' | 'closed';
  procurementType?: 'quotation' | 'tender' | 'requisition';
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
  sources: string[];
  procurementTypes: string[];
}

const MAX_PAGE_SIZE = 100;

function completeness(t: Tender): number {
  return [t.ministry, t.agency, t.category, t.advertisedDate, t.closingDate, t.indicativePrice]
    .filter((v) => v !== null).length + t.events.length + t.fieldCodes.length;
}

export function dedupeTenders(tenders: Tender[]): Tender[] {
  const byKey = new Map<string, Tender>();
  for (const t of tenders) {
    const existing = byKey.get(t.dedupKey);
    if (!existing) {
      byKey.set(t.dedupKey, t);
      continue;
    }
    const cNew = completeness(t);
    const cOld = completeness(existing);
    if (cNew > cOld || (cNew === cOld && t.scrapedAt > existing.scrapedAt)) {
      byKey.set(t.dedupKey, t);
    }
  }
  return [...byKey.values()];
}

export function queryTenders(tenders: Tender[], q: TenderQuery, opts: { deduped?: boolean } = {}): TenderPage {
  let items = opts.deduped ? tenders : dedupeTenders(tenders);

  if (q.search) {
    const needle = q.search.toLowerCase();
    items = items.filter(
      (t) => t.title.toLowerCase().includes(needle) || t.referenceNo.toLowerCase().includes(needle),
    );
  }
  if (q.ministry) items = items.filter((t) => t.ministry === q.ministry);
  if (q.agency) items = items.filter((t) => t.agency === q.agency);
  if (q.category) items = items.filter((t) => t.category === q.category);
  if (q.source) items = items.filter((t) => t.source === q.source);
  if (q.status) items = items.filter((t) => t.status === q.status);
  if (q.procurementType) items = items.filter((t) => t.procurementType === q.procurementType);

  const sortBy = q.sortBy ?? 'advertisedDate';
  const dir = (q.sortOrder ?? 'desc') === 'asc' ? 1 : -1;
  items.sort((a, b) => {
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
    items: items.slice((page - 1) * pageSize, page * pageSize),
    total: items.length,
    page,
    pageSize,
  };
}

export function buildFacets(tenders: Tender[], opts: { deduped?: boolean } = {}): Facets {
  const deduped = opts.deduped ? tenders : dedupeTenders(tenders);
  const distinct = (vals: Array<string | null>) =>
    [...new Set(vals.filter((v): v is string => v !== null))].sort();
  return {
    ministries: distinct(deduped.map((t) => t.ministry)),
    agencies: distinct(deduped.map((t) => t.agency)),
    categories: distinct(deduped.map((t) => t.category)),
    sources: distinct(deduped.map((t) => t.source)),
    procurementTypes: distinct(deduped.map((t) => t.procurementType)),
  };
}

export function findById(
  tenders: Tender[],
  id: string,
): { tender: Tender; alsoAvailableFrom: Tender[] } | null {
  const tender = tenders.find((t) => t.id === id);
  if (!tender) return null;
  return {
    tender,
    alsoAvailableFrom: tenders.filter((t) => t.dedupKey === tender.dedupKey && t.id !== tender.id),
  };
}
