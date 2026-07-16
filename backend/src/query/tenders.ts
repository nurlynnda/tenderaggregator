import type { Tender } from '@tms/shared';
import type { QueryableCollection, TenderDoc } from '../storage/tenderDoc.js';
import { fromDoc } from '../storage/tenderDoc.js';

export interface TenderQuery {
  search?: string;
  ministry?: string;
  agency?: string;
  category?: string;
  source?: string;
  closingFrom?: string;
  closingTo?: string;
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
  sources: string[];
  procurementTypes: string[];
  fieldCodes: string[];
}

const MAX_PAGE_SIZE = 100;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildMatchStage(q: TenderQuery): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  if (q.search) {
    const pattern = escapeRegex(q.search);
    match.$or = [
      { title: { $regex: pattern, $options: 'i' } },
      { referenceNo: { $regex: pattern, $options: 'i' } },
    ];
  }
  if (q.ministry) match.ministry = q.ministry;
  if (q.agency) match.agency = q.agency;
  if (q.category) match.category = q.category;
  if (q.source) match['sources.source'] = q.source;
  if (q.closingFrom || q.closingTo) {
    const range: Record<string, string> = {};
    if (q.closingFrom) range.$gte = q.closingFrom;
    if (q.closingTo) range.$lte = q.closingTo;
    match.closingDate = range;
  }
  if (q.status) match.status = q.status;
  if (q.procurementType) match.procurementType = q.procurementType;
  if (q.fieldCode) match.fieldCodes = { $regex: `^${escapeRegex(q.fieldCode)}`, $options: 'i' };
  if (q.hasWinners) match.winners = { $ne: null, $not: { $size: 0 } };
  if (q.contractor) match.winners = { $elemMatch: { name: { $regex: escapeRegex(q.contractor), $options: 'i' } } };
  return match;
}

export async function queryTenders(collection: QueryableCollection<TenderDoc>, q: TenderQuery): Promise<TenderPage> {
  const match = buildMatchStage(q);
  const sortBy = q.sortBy ?? 'advertisedDate';
  const dir = (q.sortOrder ?? 'desc') === 'asc' ? 1 : -1;
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, q.pageSize ?? 20));

  const pipeline = [
    { $match: match },
    { $addFields: { __sortMissing: { $cond: [{ $eq: [`$${sortBy}`, null] }, 1, 0] } } },
    { $sort: { __sortMissing: 1, [sortBy]: dir } },
    {
      $facet: {
        items: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }, { $project: { __sortMissing: 0 } }],
        totalCount: [{ $count: 'count' }],
      },
    },
  ];

  const [result] = await collection
    .aggregate<{ items: TenderDoc[]; totalCount: Array<{ count: number }> }>(pipeline)
    .toArray();
  return {
    items: (result?.items ?? []).map(fromDoc),
    total: result?.totalCount[0]?.count ?? 0,
    page,
    pageSize,
  };
}

export async function buildFacets(collection: QueryableCollection<TenderDoc>): Promise<Facets> {
  const distinctSorted = async (field: string): Promise<string[]> => {
    const values = (await collection.distinct(field)) as Array<string | null>;
    return values.filter((v): v is string => v !== null).sort();
  };
  const [ministries, agencies, categories, sources, procurementTypes, fieldCodes] = await Promise.all([
    distinctSorted('ministry'),
    distinctSorted('agency'),
    distinctSorted('category'),
    distinctSorted('sources.source'),
    distinctSorted('procurementType'),
    distinctSorted('fieldCodes'),
  ]);
  return { ministries, agencies, categories, sources, procurementTypes, fieldCodes };
}
