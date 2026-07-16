import type { Tender } from '@tms/shared';

export interface TenderDoc extends Omit<Tender, 'dedupKey'> {
  _id: string;
  _provenance: Record<string, string>;
}

export interface FindCursorLike<T> {
  toArray(): Promise<T[]>;
}

export interface AggregationCursorLike<R> {
  // Widened from `Promise<R[]>`: the real `mongodb` driver's `AggregationCursor<T>.toArray()`
  // always resolves to `Promise<Document[]>` regardless of the generic `R` the caller asked
  // for (the driver doesn't thread the pipeline's output type through), so a strict
  // `Promise<R[]>` here is never structurally satisfied by `Collection<T>['aggregate']`. Any
  // object with a compatible `toArray()` is accepted instead; callers still get the `R[]`
  // they asked for via the `aggregate<R>()` generic below.
  toArray(): Promise<unknown[]>;
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
