import type { Tender } from '@tms/shared';

// Local structural alias for the `mongodb` package's `Document` type (a plain object),
// used so `QueryableCollection.aggregate()`'s pipeline parameter and generic bound match
// the shape `Collection<T>.aggregate()` expects, without adding a compile-time dependency
// on the `mongodb` package's types in this file.
type Document = Record<string, unknown>;

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
  deleteOne(filter: Record<string, unknown>): Promise<unknown>;
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
  distinct(field: string, filter?: Record<string, unknown>): Promise<unknown[]>;
  aggregate<R extends Document = Document>(pipeline: Document[]): AggregationCursorLike<R>;
}

export function toDoc(tender: Tender, provenance: Record<string, string>): TenderDoc {
  const { dedupKey, ...rest } = tender;
  return { _id: dedupKey, ...rest, _provenance: provenance };
}

export function fromDoc(doc: TenderDoc): Tender {
  const { _id, _provenance, ...rest } = doc;
  return { dedupKey: _id, ...rest };
}
