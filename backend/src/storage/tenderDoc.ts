import type { Tender } from '@tms/shared';

export interface TenderDoc extends Omit<Tender, 'dedupKey'> {
  _id: string;
  _provenance: Record<string, string>;
}

export interface FindCursorLike<T> {
  toArray(): Promise<T[]>;
}

export interface AggregationCursorLike<R> {
  toArray(): Promise<R[]>;
}

export interface QueryableCollection<T> {
  findOne(filter: Record<string, unknown>): Promise<T | null>;
  find(filter: Record<string, unknown>): FindCursorLike<T>;
  replaceOne(
    filter: Record<string, unknown>,
    doc: T,
    options?: { upsert?: boolean },
  ): Promise<unknown>;
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>;
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
  distinct(field: string, filter?: Record<string, unknown>): Promise<unknown[]>;
  aggregate<R = unknown>(pipeline: Record<string, unknown>[]): AggregationCursorLike<R>;
}

export function toDoc(tender: Tender, provenance: Record<string, string>): TenderDoc {
  const { dedupKey, ...rest } = tender;
  return { _id: dedupKey, ...rest, _provenance: provenance };
}

export function fromDoc(doc: TenderDoc): Tender {
  const { _id, _provenance, ...rest } = doc;
  return { dedupKey: _id, ...rest };
}
