# MongoDB Storage Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the JSON-file storage layer (`backend/data/**`) with MongoDB, so tenders, per-source scrape metadata, and scheduler state live in a Mongo database instead of on-disk files, and ship a `docker-compose.prod.yml` that connects to the user's existing production mongo stack.

**Architecture:** `TenderRepository` and `dailyRunState` are rewritten against three Mongo collections (`tenders`, `sourceMeta`, `schedulerState`) instead of JSON files. `queryTenders`/`buildFacets` become Mongo query/aggregation builders; `buildDashboardStats` keeps its exact JS logic, fed by a new `repo.findAwarded()` Mongo query. Every repository/query method becomes `async`, rippling `await` through `manager.ts`, `app.ts`, and `index.ts`. Tests inject a hand-written in-memory fake that implements only the Mongo driver methods this codebase actually calls — no real Mongo process in tests.

**Tech Stack:** `mongodb` npm driver (not Mongoose), existing Express/Zod/TypeScript/ESM stack, Vitest.

## Global Constraints

- No data migration script — Mongo starts empty; existing startup scrape policy repopulates it (per `docs/superpowers/specs/2026-07-16-mongodb-storage-migration-design.md`).
- Reads go straight to Mongo — no in-memory cache in `TenderRepository`.
- Field provenance embedded in the tender doc as `_provenance`, not a separate collection.
- Merge logic (`mergeOne`) stays read-modify-write in plain JS — no atomic Mongo update operators.
- Tests use a hand-written fake Mongo collection (`backend/test/support/fakeMongoCollection.ts`), never `mongodb-memory-server` or a real Mongo process.
- Dev Mongo (`docker-compose.yml`) runs as plain standalone `mongo:8`, no replica set.
- `queryTenders`/`buildFacets` become real Mongo queries; `buildDashboardStats` keeps its JS contractor-normalization logic unchanged, fed by a Mongo-filtered subset.
- Prod backend container gets `container_name: tender-aggregator-backend` (and frontend `tender-aggregator-frontend`) to avoid colliding with other stacks on the shared `shared-mongo` network.
- Every step must leave `npm test` green before moving to the next task (per CLAUDE.md TDD rule — write failing test first, minimal implementation, confirm pass, commit).
- Coverage thresholds (80% lines/branches, `backend/vitest.config.ts`) must stay satisfied — `src/index.ts` is excluded from coverage, everything else isn't.

---

### Task 1: `mongodb` dependency, tender-doc mapping module, and shared fake Mongo collection

**Files:**
- Modify: `backend/package.json`
- Create: `backend/src/storage/tenderDoc.ts`
- Create: `backend/test/support/fakeMongoCollection.ts`
- Test: `backend/test/support/fakeMongoCollection.test.ts`

**Interfaces:**
- Produces: `TenderDoc` type, `toDoc(tender: Tender, provenance: Record<string,string>): TenderDoc`, `fromDoc(doc: TenderDoc): Tender` — consumed by Task 2 (`repository.ts`) and Task 5 (`query/tenders.ts`).
- Produces: `QueryableCollection<T>` interface — the minimal Mongo driver surface (`findOne`, `find`, `replaceOne`, `updateMany`, `countDocuments`, `distinct`, `aggregate`) that both the real `mongodb` driver's `Collection<T>` and `FakeCollection<T>` satisfy structurally. Consumed by Tasks 2 and 5.
- Produces: `FakeCollection<T>` class — consumed by every test file touching a repository/query in Tasks 2, 4, 5, 6, 7.

- [ ] **Step 1: Add the `mongodb` dependency**

Run: `npm install mongodb --workspace backend`

Expected: `backend/package.json` gains `"mongodb": "^6.x.x"` under `dependencies`, and `package-lock.json` updates.

- [ ] **Step 2: Write `backend/src/storage/tenderDoc.ts`**

```ts
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
```

- [ ] **Step 3: Write the failing test for `FakeCollection`**

Create `backend/test/support/fakeMongoCollection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FakeCollection } from './fakeMongoCollection.js';

interface Doc {
  _id: string;
  status: 'open' | 'closed';
  ministry: string | null;
  fieldCodes: string[];
  winners: Array<{ name: string; price: number | null }> | null;
  sources: Array<{ source: string }>;
  closingDate: string | null;
  advertisedDate: string | null;
}

function doc(overrides: Partial<Doc> = {}): Doc {
  return {
    _id: 'A', status: 'open', ministry: null, fieldCodes: [], winners: null,
    sources: [{ source: 'myprocurement' }], closingDate: null, advertisedDate: '2026-01-01',
    ...overrides,
  };
}

describe('FakeCollection', () => {
  it('findOne matches by exact field value, including _id', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', status: 'open' }), { upsert: true });
    expect((await col.findOne({ _id: 'A' }))?.status).toBe('open');
    expect(await col.findOne({ _id: 'NOPE' })).toBeNull();
  });

  it('replaceOne upserts, and updates in place on a second call with the same filter', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ status: 'open' }), { upsert: true });
    await col.replaceOne({ _id: 'A' }, doc({ status: 'closed' }), { upsert: true });
    expect((await col.find({}).toArray())).toHaveLength(1);
    expect((await col.findOne({ _id: 'A' }))?.status).toBe('closed');
  });

  it('find with $regex/$options matches case-insensitively', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', ministry: 'KEMENTERIAN BESAR' }), { upsert: true });
    const results = await col.find({ ministry: { $regex: 'besar', $options: 'i' } }).toArray();
    expect(results).toHaveLength(1);
  });

  it('find with $regex on a scalar array field matches if any element matches', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', fieldCodes: ['220801'] }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', fieldCodes: ['010101'] }), { upsert: true });
    const results = await col.find({ fieldCodes: { $regex: '^22', $options: 'i' } }).toArray();
    expect(results.map((d) => d._id)).toEqual(['A']);
  });

  it('find with a dotted path auto-traverses arrays of subdocuments', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', sources: [{ source: 'span' }] }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', sources: [{ source: 'kwsp' }] }), { upsert: true });
    const results = await col.find({ 'sources.source': 'span' }).toArray();
    expect(results.map((d) => d._id)).toEqual(['A']);
  });

  it('find with $ne/$not/$size treats the field as a whole array, not per-element', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', winners: [{ name: 'X', price: 1 }] }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', winners: [] }), { upsert: true });
    await col.replaceOne({ _id: 'C' }, doc({ _id: 'C', winners: null }), { upsert: true });
    const results = await col.find({ winners: { $ne: null, $not: { $size: 0 } } }).toArray();
    expect(results.map((d) => d._id)).toEqual(['A']);
  });

  it('find with $elemMatch matches a subdocument array element on a nested field', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', winners: [{ name: 'SAFWORKS SDN BHD', price: 1 }] }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', winners: [{ name: 'OTHER', price: 2 }] }), { upsert: true });
    const results = await col.find({ winners: { $elemMatch: { name: { $regex: 'safworks', $options: 'i' } } } }).toArray();
    expect(results.map((d) => d._id)).toEqual(['A']);
  });

  it('find with $gte/$lte on the same field applies both bounds, excluding null', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', closingDate: '2026-07-05' }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', closingDate: '2026-07-15' }), { upsert: true });
    await col.replaceOne({ _id: 'C' }, doc({ _id: 'C', closingDate: '2026-07-25' }), { upsert: true });
    await col.replaceOne({ _id: 'D' }, doc({ _id: 'D', closingDate: null }), { upsert: true });
    const results = await col.find({ closingDate: { $gte: '2026-07-10', $lte: '2026-07-20' } }).toArray();
    expect(results.map((d) => d._id)).toEqual(['B']);
  });

  it('find with $or matches any subfilter', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', ministry: 'X' }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', status: 'closed' }), { upsert: true });
    await col.replaceOne({ _id: 'C' }, doc({ _id: 'C' }), { upsert: true });
    const results = await col.find({ $or: [{ ministry: 'X' }, { status: 'closed' }] }).toArray();
    expect(results.map((d) => d._id).sort()).toEqual(['A', 'B']);
  });

  it('updateMany applies $set to every document matching the filter and reports modifiedCount', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', status: 'open' }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', status: 'open' }), { upsert: true });
    const result = await col.updateMany({ _id: { $in: ['A', 'B'] } as unknown }, { $set: { status: 'closed' } });
    expect((await col.find({}).toArray()).every((d) => d.status === 'closed')).toBe(true);
    expect(result).toMatchObject({ modifiedCount: 2 });
  });

  it('countDocuments counts matches only', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', status: 'open' }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', status: 'closed' }), { upsert: true });
    expect(await col.countDocuments({ status: 'open' })).toBe(1);
    expect(await col.countDocuments()).toBe(2);
  });

  it('distinct returns unique non-null values, flattening array fields including dotted paths', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', fieldCodes: ['010101', '220801'] }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', fieldCodes: ['010101'] }), { upsert: true });
    expect((await col.distinct('fieldCodes')).sort()).toEqual(['010101', '220801']);
    expect(await col.distinct('sources.source')).toEqual(['myprocurement']);
  });

  it('aggregate supports match/addFields/sort/facet/count for the paginated-query pipeline shape', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', advertisedDate: '2026-01-01' }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', advertisedDate: null }), { upsert: true });
    await col.replaceOne({ _id: 'C' }, doc({ _id: 'C', advertisedDate: '2026-06-01' }), { upsert: true });
    const pipeline = [
      { $match: {} },
      { $addFields: { __sortMissing: { $cond: [{ $eq: ['$advertisedDate', null] }, 1, 0] } } },
      { $sort: { __sortMissing: 1, advertisedDate: -1 } },
      {
        $facet: {
          items: [{ $skip: 0 }, { $limit: 2 }, { $project: { __sortMissing: 0 } }],
          totalCount: [{ $count: 'count' }],
        },
      },
    ];
    const [result] = await col.aggregate<{ items: Doc[]; totalCount: Array<{ count: number }> }>(pipeline).toArray();
    expect(result!.items.map((d) => d._id)).toEqual(['C', 'A']); // newest first, null pushed last
    expect(result!.totalCount[0]!.count).toBe(3);
    expect((result!.items[0] as unknown as Record<string, unknown>).__sortMissing).toBeUndefined(); // $project stripped it
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -w backend -- fakeMongoCollection`
Expected: FAIL — `fakeMongoCollection.ts` module not found.

- [ ] **Step 5: Write `backend/test/support/fakeMongoCollection.ts`**

```ts
type Filter = Record<string, unknown>;

function getRaw(doc: unknown, field: string): unknown {
  return (doc as Record<string, unknown> | null | undefined)?.[field];
}

function evalOperators(value: unknown, condition: Record<string, unknown>): boolean {
  return Object.entries(condition).every(([op, arg]) => {
    switch (op) {
      case '$regex': {
        const flags = typeof condition.$options === 'string' ? condition.$options : '';
        return typeof value === 'string' && new RegExp(arg as string, flags).test(value);
      }
      case '$options':
        return true; // consumed together with $regex
      case '$gte':
        return value !== null && value !== undefined && (value as string | number) >= (arg as string | number);
      case '$lte':
        return value !== null && value !== undefined && (value as string | number) <= (arg as string | number);
      case '$ne':
        return value !== arg;
      case '$eq':
        return value === arg;
      case '$in':
        return Array.isArray(arg) && arg.includes(value);
      case '$size':
        return Array.isArray(value) && value.length === (arg as number);
      case '$not':
        return !matchesValue(value, arg);
      case '$elemMatch':
        return Array.isArray(value) && value.some((el) => matchesDoc(el, arg as Filter));
      default:
        throw new Error(`FakeCollection: unsupported operator ${op}`);
    }
  });
}

function isOperatorObject(condition: unknown): condition is Record<string, unknown> {
  return condition !== null && typeof condition === 'object' && !Array.isArray(condition);
}

function matchesValue(value: unknown, condition: unknown): boolean {
  if (isOperatorObject(condition)) return evalOperators(value, condition);
  return value === condition;
}

const ARRAY_LEVEL_OPS = new Set(['$size', '$elemMatch', '$ne']);

function matchesField(doc: unknown, field: string, condition: unknown): boolean {
  if (field.includes('.')) {
    const [head, ...restParts] = field.split('.');
    const rest = restParts.join('.');
    const headVal = getRaw(doc, head);
    const arr = Array.isArray(headVal) ? headVal : [headVal];
    return arr.some((el) => matchesField(el ?? {}, rest, condition));
  }
  const value = getRaw(doc, field);
  const isArrayLevelOp =
    isOperatorObject(condition) && Object.keys(condition).some((k) => ARRAY_LEVEL_OPS.has(k));
  if (Array.isArray(value) && !isArrayLevelOp) {
    return value.some((el) => matchesValue(el, condition));
  }
  return matchesValue(value, condition);
}

function matchesDoc(doc: unknown, filter: Filter): boolean {
  return Object.entries(filter).every(([field, condition]) => {
    if (field === '$or') return (condition as Filter[]).some((sub) => matchesDoc(doc, sub));
    return matchesField(doc, field, condition);
  });
}

function evalExpr(doc: unknown, expr: unknown): unknown {
  if (typeof expr === 'string' && expr.startsWith('$')) return getRaw(doc, expr.slice(1));
  if (expr !== null && typeof expr === 'object' && !Array.isArray(expr)) {
    const obj = expr as Record<string, unknown>;
    if ('$cond' in obj) {
      const [cond, then, els] = obj.$cond as unknown[];
      return evalExpr(doc, cond) ? evalExpr(doc, then) : evalExpr(doc, els);
    }
    if ('$eq' in obj) {
      const [a, b] = obj.$eq as unknown[];
      return evalExpr(doc, a) === evalExpr(doc, b);
    }
    throw new Error('FakeCollection: unsupported aggregation expression');
  }
  return expr;
}

export class FakeCollection<T extends { _id: string }> {
  private readonly docs = new Map<string, T>();

  async findOne(filter: Filter): Promise<T | null> {
    for (const doc of this.docs.values()) if (matchesDoc(doc, filter)) return doc;
    return null;
  }

  find(filter: Filter = {}): { toArray(): Promise<T[]> } {
    const rows = [...this.docs.values()].filter((doc) => matchesDoc(doc, filter));
    return { toArray: async () => rows };
  }

  async replaceOne(filter: Filter, doc: T, options: { upsert?: boolean } = {}): Promise<{ upsertedCount: number }> {
    const id = (filter._id as string | undefined) ?? doc._id;
    const existed = this.docs.has(id);
    this.docs.set(id, doc);
    return { upsertedCount: existed || !options.upsert ? 0 : 1 };
  }

  async updateMany(filter: Filter, update: { $set: Partial<T> }): Promise<{ modifiedCount: number }> {
    let modifiedCount = 0;
    for (const [id, doc] of this.docs.entries()) {
      if (!matchesDoc(doc, filter)) continue;
      this.docs.set(id, { ...doc, ...update.$set });
      modifiedCount += 1;
    }
    return { modifiedCount };
  }

  async countDocuments(filter: Filter = {}): Promise<number> {
    return [...this.docs.values()].filter((doc) => matchesDoc(doc, filter)).length;
  }

  async distinct(field: string, filter: Filter = {}): Promise<unknown[]> {
    const results = new Set<unknown>();
    for (const doc of this.docs.values()) {
      if (!matchesDoc(doc, filter)) continue;
      for (const v of collectPath(doc, field)) if (v !== null && v !== undefined) results.add(v);
    }
    return [...results];
  }

  aggregate<R = unknown>(pipeline: Filter[]): { toArray(): Promise<R[]> } {
    const rows = this.runPipeline([...this.docs.values()], pipeline);
    return { toArray: async () => rows as R[] };
  }

  private runPipeline(input: unknown[], pipeline: Filter[]): unknown[] {
    let rows = input;
    for (const stage of pipeline) {
      if ('$match' in stage) {
        rows = rows.filter((d) => matchesDoc(d, stage.$match as Filter));
      } else if ('$addFields' in stage) {
        const fields = stage.$addFields as Record<string, unknown>;
        rows = rows.map((d) => {
          const copy = { ...(d as Record<string, unknown>) };
          for (const [k, expr] of Object.entries(fields)) copy[k] = evalExpr(d, expr);
          return copy;
        });
      } else if ('$sort' in stage) {
        const sortSpec = Object.entries(stage.$sort as Record<string, 1 | -1>);
        rows = [...rows].sort((a, b) => {
          for (const [k, dir] of sortSpec) {
            const av = getRaw(a, k);
            const bv = getRaw(b, k);
            if (av === bv) continue;
            if (av === null || av === undefined) return dir;
            if (bv === null || bv === undefined) return -dir;
            return (av as string) < (bv as string) ? -dir : dir;
          }
          return 0;
        });
      } else if ('$skip' in stage) {
        rows = rows.slice(stage.$skip as number);
      } else if ('$limit' in stage) {
        rows = rows.slice(0, stage.$limit as number);
      } else if ('$project' in stage) {
        const proj = stage.$project as Record<string, 0 | 1>;
        rows = rows.map((d) => {
          const copy = { ...(d as Record<string, unknown>) };
          for (const [k, v] of Object.entries(proj)) if (v === 0) delete copy[k];
          return copy;
        });
      } else if ('$count' in stage) {
        rows = [{ [stage.$count as string]: rows.length }];
      } else if ('$facet' in stage) {
        const facets = stage.$facet as Record<string, Filter[]>;
        const result: Record<string, unknown[]> = {};
        for (const [name, subPipeline] of Object.entries(facets)) result[name] = this.runPipeline(rows, subPipeline);
        rows = [result];
      } else {
        throw new Error(`FakeCollection: unsupported aggregation stage ${Object.keys(stage)[0]}`);
      }
    }
    return rows;
  }
}

function collectPath(doc: unknown, path: string): unknown[] {
  const parts = path.split('.');
  let current: unknown[] = [doc];
  for (const part of parts) {
    const next: unknown[] = [];
    for (const item of current) {
      const v = getRaw(item, part);
      if (Array.isArray(v)) next.push(...v);
      else next.push(v);
    }
    current = next;
  }
  return current;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -w backend -- fakeMongoCollection`
Expected: PASS, all 13 tests green.

- [ ] **Step 7: Commit**

```bash
git add backend/package.json package-lock.json backend/src/storage/tenderDoc.ts backend/test/support/fakeMongoCollection.ts backend/test/support/fakeMongoCollection.test.ts
git commit -m "feat: add mongodb driver, tender-doc mapping, and fake Mongo collection for tests"
```

---

### Task 2: Rewrite `TenderRepository` against Mongo collections

**Files:**
- Modify: `backend/src/storage/repository.ts` (full rewrite)
- Modify: `backend/test/repository.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `TenderDoc`, `toDoc`, `fromDoc`, `QueryableCollection<T>` from `backend/src/storage/tenderDoc.js` (Task 1); `FakeCollection` from `backend/test/support/fakeMongoCollection.js` (Task 1).
- Produces: `TenderRepository` constructed as `new TenderRepository(tenders: QueryableCollection<TenderDoc>, sourceMeta: QueryableCollection<SourceMetaDoc>)`, with async methods `getAll(): Promise<Tender[]>`, `findByDedupKey(key): Promise<Tender|null>`, `findAwarded(): Promise<Tender[]>`, `hasSource(source): Promise<boolean>`, `getSourceCount(source): Promise<number>`, `mergeMany(patches): Promise<void>`, `reconcileStaleOpen(now?): Promise<number>`, `getMeta(source): Promise<SourceMeta>`, `setMeta(source, patch): Promise<void>`. Also exports `SourceMeta` and `SourceMetaDoc` types. Consumed by Tasks 5, 6, 7, 8.

- [ ] **Step 1: Write the failing test — replace `backend/test/repository.test.ts` in full**

```ts
import { describe, expect, it } from 'vitest';
import type { Tender, TenderPatch } from '@tms/shared';
import { TenderRepository } from '../src/storage/repository.js';
import type { SourceMetaDoc } from '../src/storage/repository.js';
import type { TenderDoc } from '../src/storage/tenderDoc.js';
import { FakeCollection } from './support/fakeMongoCollection.js';

function makePatch(overrides: Partial<TenderPatch> = {}): TenderPatch {
  return {
    dedupKey: 'REF/1', referenceNo: 'REF/1', title: 'T1',
    status: 'open', procurementType: 'quotation',
    scrapedAt: '2026-07-07T00:00:00.000Z',
    source: { source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1' },
    ...overrides,
  };
}

function freshRepo() {
  const tenders = new FakeCollection<TenderDoc>();
  const sourceMeta = new FakeCollection<SourceMetaDoc>();
  return { tenders, sourceMeta, repo: new TenderRepository(tenders, sourceMeta) };
}

describe('TenderRepository', () => {
  it('starts empty and reports missing sources', async () => {
    const { repo } = freshRepo();
    expect(await repo.getAll()).toEqual([]);
    expect(await repo.hasSource('myprocurement')).toBe(false);
  });

  it('seeds a new merged record from the first patch, defaulting unobserved fields', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch()]);
    const [t] = await repo.getAll();
    expect(t).toEqual<Tender>({
      dedupKey: 'REF/1', referenceNo: 'REF/1', title: 'T1',
      status: 'open', procurementType: 'quotation',
      ministry: null, agency: null, category: null, fieldCodes: [],
      advertisedDate: null, closingDate: null, indicativePrice: null,
      currency: 'MYR', events: [], winners: null, raw: {},
      scrapedAt: '2026-07-07T00:00:00.000Z',
      sources: [{ source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1' }],
    });
  });

  it('overwrites a field when a newer patch observes it', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ ministry: 'OLD', scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    await repo.mergeMany([makePatch({ ministry: 'NEW', scrapedAt: '2026-07-07T00:00:00.000Z' })]);
    expect((await repo.getAll())[0]!.ministry).toBe('NEW');
  });

  it('never lets a null value clobber an already-known value, even if the patch is newer', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ ministry: 'KNOWN', scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    await repo.mergeMany([makePatch({ ministry: null, scrapedAt: '2026-07-07T00:00:00.000Z' })]);
    expect((await repo.getAll())[0]!.ministry).toBe('KNOWN');
  });

  it("never lets a different source's unclassifiable (null) procurementType clobber an already-known type", async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ procurementType: 'tender', scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    await repo.mergeMany([makePatch({
      procurementType: null,
      scrapedAt: '2026-07-07T00:00:00.000Z',
      source: { source: 'span', sourceId: '9', sourceUrl: 'https://www.span.gov.my/tender/view/9' },
    })]);
    expect((await repo.getAll())[0]!.procurementType).toBe('tender');
  });

  it("never lets a different source without fieldCodes/winners erase values another source already contributed", async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({
      fieldCodes: ['E05'],
      winners: [{ name: 'X', price: 1 }],
      scrapedAt: '2026-07-01T00:00:00.000Z',
    })]);
    await repo.mergeMany([makePatch({
      scrapedAt: '2026-07-07T00:00:00.000Z',
      source: { source: 'span', sourceId: '9', sourceUrl: 'https://www.span.gov.my/tender/view/9' },
    })]);
    const [t] = await repo.getAll();
    expect(t!.fieldCodes).toEqual(['E05']);
    expect(t!.winners).toEqual([{ name: 'X', price: 1 }]);
  });

  it("KWSP: preserves an open tender's advertisedDate AND closingDate when a later results patch (same dedupKey) never observed them, while updating status/winners", async () => {
    const { repo } = freshRepo();
    const openSource = {
      source: 'kwsp', sourceId: 'sample-doc',
      sourceUrl: 'https://www.kwsp.gov.my/documents/d/guest/sample-doc',
    };
    const resultsSource = {
      source: 'kwsp', sourceId: 'Doc1234567890',
      sourceUrl: 'https://www.kwsp.gov.my/en/corporate/procurement/tenders',
    };
    await repo.mergeMany([makePatch({
      dedupKey: 'DOC1234567890', referenceNo: 'Doc1234567890', title: 'Sample KWSP Tender',
      procurementType: 'tender',
      advertisedDate: '2026-07-01', closingDate: '2026-07-15',
      scrapedAt: '2026-07-01T00:00:00.000Z', source: openSource,
    })]);
    await repo.mergeMany([makePatch({
      dedupKey: 'DOC1234567890', referenceNo: 'Doc1234567890', title: 'Sample KWSP Tender',
      status: 'closed', procurementType: 'tender',
      scrapedAt: '2026-08-05T00:00:00.000Z', source: resultsSource,
      winners: [{ name: 'Winner Sdn Bhd', price: null }],
    })]);
    const [t] = await repo.getAll();
    expect(t!.status).toBe('closed');
    expect(t!.winners).toEqual([{ name: 'Winner Sdn Bhd', price: null }]);
    expect(t!.closingDate).toBe('2026-07-15');
    expect(t!.advertisedDate).toBe('2026-07-01');
    expect(t!.sources).toEqual([resultsSource]);
  });

  it('ignores an older (out-of-order) patch for a field already set by a newer one', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ ministry: 'NEWER', scrapedAt: '2026-07-07T00:00:00.000Z' })]);
    await repo.mergeMany([makePatch({ ministry: 'STALE', scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    expect((await repo.getAll())[0]!.ministry).toBe('NEWER');
  });

  it('leaves a field untouched when a later patch never observed it', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ fieldCodes: ['010101'], scrapedAt: '2026-07-01T00:00:00.000Z' })]);
    await repo.mergeMany([makePatch({ winners: [{ name: 'X', price: 1 }], scrapedAt: '2026-07-07T00:00:00.000Z' })]);
    const [t] = await repo.getAll();
    expect(t!.fieldCodes).toEqual(['010101']);
    expect(t!.winners).toEqual([{ name: 'X', price: 1 }]);
  });

  it('accumulates distinct sources and updates an existing source entry in place', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch()]);
    await repo.mergeMany([makePatch({ source: { source: 'otherSource', sourceId: '9', sourceUrl: 'https://other.example/9' } })]);
    expect((await repo.getAll())[0]!.sources).toHaveLength(2);
    await repo.mergeMany([makePatch({ source: { source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1-updated' } })]);
    const sources = (await repo.getAll())[0]!.sources;
    expect(sources).toHaveLength(2);
    expect(sources.find((s) => s.source === 'myprocurement')?.sourceUrl).toBe('https://example.com/1-updated');
  });

  it('findByDedupKey returns the merged record or null', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch()]);
    expect((await repo.findByDedupKey('REF/1'))?.title).toBe('T1');
    expect(await repo.findByDedupKey('NOPE')).toBeNull();
  });

  it('getSourceCount counts merged records with a contribution from that source', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ dedupKey: 'A', referenceNo: 'A' })]);
    await repo.mergeMany([makePatch({ dedupKey: 'B', referenceNo: 'B', source: { source: 'other', sourceId: '1', sourceUrl: 'https://x/1' } })]);
    expect(await repo.getSourceCount('myprocurement')).toBe(1);
    expect(await repo.getSourceCount('other')).toBe(1);
    expect(await repo.getSourceCount('nope')).toBe(0);
  });

  it('a second repository instance backed by the same underlying collection sees merged data and respects provenance', async () => {
    const { tenders, sourceMeta, repo } = freshRepo();
    await repo.mergeMany([makePatch()]);

    const repo2 = new TenderRepository(tenders, sourceMeta);
    expect(await repo2.getAll()).toHaveLength(1);
    await repo2.mergeMany([makePatch({ title: 'STALE TITLE', scrapedAt: '2026-01-01T00:00:00.000Z' })]);
    expect((await repo2.getAll())[0]!.title).toBe('T1');
  });

  it('meta defaults, patches, and persists per source; hasSource reflects a completed scrape', async () => {
    const { tenders, sourceMeta, repo } = freshRepo();
    expect(await repo.getMeta('myprocurement')).toEqual({
      lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0, completedArchiveJobs: [],
    });
    expect(await repo.hasSource('myprocurement')).toBe(false);
    await repo.setMeta('myprocurement', { lastArchiveBackfillAt: '2026-07-07T00:00:00.000Z', total: 5 });
    expect(await repo.hasSource('myprocurement')).toBe(true);

    const repo2 = new TenderRepository(tenders, sourceMeta);
    expect((await repo2.getMeta('myprocurement')).lastArchiveBackfillAt).toBe('2026-07-07T00:00:00.000Z');
    expect(await repo2.hasSource('myprocurement')).toBe(true);
  });

  it('persists completedArchiveJobs across reloads (backfill-completeness per job kind)', async () => {
    const { tenders, sourceMeta, repo } = freshRepo();
    await repo.setMeta('myprocurement', { completedArchiveJobs: ['closed-quotation'] });
    await repo.setMeta('myprocurement', { completedArchiveJobs: ['closed-quotation', 'closed-tender'] });
    expect((await repo.getMeta('myprocurement')).completedArchiveJobs).toEqual(['closed-quotation', 'closed-tender']);

    const repo2 = new TenderRepository(tenders, sourceMeta);
    expect((await repo2.getMeta('myprocurement')).completedArchiveJobs).toEqual(['closed-quotation', 'closed-tender']);
  });

  it('handles a large merge (archive scale) without quadratic behavior', async () => {
    const { repo } = freshRepo();
    const big = Array.from({ length: 20000 }, (_, i) => makePatch({ dedupKey: `REF/${i}`, referenceNo: `REF/${i}` }));
    const start = Date.now();
    await repo.mergeMany(big);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(await repo.getAll()).toHaveLength(20000);
  });

  it('flips an open tender to closed once past 12:01pm MYT on its closing date', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ closingDate: '2026-07-10' })]);
    const count = await repo.reconcileStaleOpen(new Date('2026-07-10T04:02:00.000Z'));
    expect(count).toBe(1);
    expect((await repo.getAll())[0]!.status).toBe('closed');
  });

  it('leaves it open before the 12:01pm MYT cutoff on the same day', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ closingDate: '2026-07-10' })]);
    const count = await repo.reconcileStaleOpen(new Date('2026-07-10T03:00:00.000Z'));
    expect(count).toBe(0);
    expect((await repo.getAll())[0]!.status).toBe('open');
  });

  it('flips exactly at the 12:01pm MYT cutoff instant', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ closingDate: '2026-07-10' })]);
    const count = await repo.reconcileStaleOpen(new Date('2026-07-10T04:01:00.000Z'));
    expect(count).toBe(1);
    expect((await repo.getAll())[0]!.status).toBe('closed');
  });

  it('leaves an already-closed tender untouched', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ status: 'closed', closingDate: '2020-01-01' })]);
    const count = await repo.reconcileStaleOpen(new Date('2026-07-10T00:00:00.000Z'));
    expect(count).toBe(0);
    expect((await repo.getAll())[0]!.status).toBe('closed');
  });

  it('flips a closing-date-less open tender to closed once more than a month past advertisedDate', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ advertisedDate: '2026-01-15' })]);
    const count = await repo.reconcileStaleOpen(new Date('2026-02-16T00:00:00+08:00'));
    expect(count).toBe(1);
    expect((await repo.getAll())[0]!.status).toBe('closed');
  });

  it('leaves a closing-date-less open tender open at exactly one month and just under', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([
      makePatch({ dedupKey: 'A', referenceNo: 'A', advertisedDate: '2026-01-15' }),
      makePatch({ dedupKey: 'B', referenceNo: 'B', advertisedDate: '2026-01-15' }),
    ]);
    const exactlyOneMonth = await repo.reconcileStaleOpen(new Date('2026-02-15T00:00:00+08:00'));
    expect(exactlyOneMonth).toBe(0);
    const justUnder = await repo.reconcileStaleOpen(new Date('2026-02-14T00:00:00+08:00'));
    expect(justUnder).toBe(0);
    expect((await repo.findByDedupKey('A'))!.status).toBe('open');
    expect((await repo.findByDedupKey('B'))!.status).toBe('open');
  });

  it('clamps the one-month fallback to the last day of a shorter target month', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ advertisedDate: '2026-01-31' })]);
    const stillOpen = await repo.reconcileStaleOpen(new Date('2026-02-28T00:00:00+08:00'));
    expect(stillOpen).toBe(0);
    const nowClosed = await repo.reconcileStaleOpen(new Date('2026-03-01T00:00:00+08:00'));
    expect(nowClosed).toBe(1);
    expect((await repo.getAll())[0]!.status).toBe('closed');
  });

  it('leaves a tender with neither closingDate nor advertisedDate untouched', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch()]);
    const count = await repo.reconcileStaleOpen(new Date('2030-01-01T00:00:00.000Z'));
    expect(count).toBe(0);
    expect((await repo.getAll())[0]!.status).toBe('open');
  });

  it('does not update provenance for status, so a later genuine patch can still overwrite it', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([makePatch({ closingDate: '2026-01-05', scrapedAt: '2026-01-01T00:00:00.000Z' })]);
    const staleCount = await repo.reconcileStaleOpen(new Date('2026-06-01T00:00:00.000Z'));
    expect(staleCount).toBe(1);
    expect((await repo.getAll())[0]!.status).toBe('closed');

    await repo.mergeMany([makePatch({ status: 'open', scrapedAt: '2026-02-01T00:00:00.000Z' })]);
    expect((await repo.getAll())[0]!.status).toBe('open');
  });

  it('returns the count of records changed, ignoring ones that are not eligible', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([
      makePatch({ dedupKey: 'STALE/1', referenceNo: 'STALE/1', closingDate: '2020-01-01' }),
      makePatch({ dedupKey: 'STALE/2', referenceNo: 'STALE/2', closingDate: '2021-01-01' }),
      makePatch({ dedupKey: 'FRESH/1', referenceNo: 'FRESH/1', closingDate: '2030-01-01' }),
    ]);
    const count = await repo.reconcileStaleOpen(new Date('2026-07-10T00:00:00.000Z'));
    expect(count).toBe(2);
    expect((await repo.findByDedupKey('STALE/1'))!.status).toBe('closed');
    expect((await repo.findByDedupKey('STALE/2'))!.status).toBe('closed');
    expect((await repo.findByDedupKey('FRESH/1'))!.status).toBe('open');
  });

  it('findAwarded returns only closed tenders with at least one winner', async () => {
    const { repo } = freshRepo();
    await repo.mergeMany([
      makePatch({ dedupKey: 'A', referenceNo: 'A', status: 'closed', winners: [{ name: 'X', price: 1 }] }),
      makePatch({ dedupKey: 'B', referenceNo: 'B', status: 'closed', winners: [] }),
      makePatch({ dedupKey: 'C', referenceNo: 'C', status: 'closed', winners: null }),
      makePatch({ dedupKey: 'D', referenceNo: 'D', status: 'open' }),
    ]);
    const awarded = await repo.findAwarded();
    expect(awarded).toHaveLength(1);
    expect(awarded[0]!.dedupKey).toBe('A');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w backend -- repository.test`
Expected: FAIL — `TenderRepository` constructor still expects a `dataDir` string, `getAll`/`mergeMany`/etc. are still sync, `findAwarded` doesn't exist.

- [ ] **Step 3: Replace `backend/src/storage/repository.ts` in full**

```ts
import type { Tender, TenderPatch } from '@tms/shared';
import type { QueryableCollection, TenderDoc } from './tenderDoc.js';
import { fromDoc, toDoc } from './tenderDoc.js';

export interface SourceMetaDoc {
  _id: string;
  lastScrapedAt: string | null;
  lastArchiveBackfillAt: string | null;
  total: number;
  completedArchiveJobs: string[];
}
export type SourceMeta = Omit<SourceMetaDoc, '_id'>;

const DEFAULT_META: SourceMeta = {
  lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0, completedArchiveJobs: [],
};

// Fields that may legitimately be scraped as null; a later patch's null must never clobber
// an already-known value for these (see design: "most-recent-non-null-wins"). Array fields
// (fieldCodes, events) and always-present identity fields don't need this guard: they never
// carry null, only omission (absent key) or an empty array, both handled by the generic loop.
const NULLABLE_FIELDS = new Set([
  'ministry', 'agency', 'category', 'advertisedDate', 'closingDate', 'indicativePrice',
  'winners', 'procurementType',
]);

export class TenderRepository {
  constructor(
    private readonly tenders: QueryableCollection<TenderDoc>,
    private readonly sourceMeta: QueryableCollection<SourceMetaDoc>,
  ) {}

  async getAll(): Promise<Tender[]> {
    const docs = await this.tenders.find({}).toArray();
    return docs.map(fromDoc);
  }

  async findByDedupKey(dedupKey: string): Promise<Tender | null> {
    const doc = await this.tenders.findOne({ _id: dedupKey });
    return doc ? fromDoc(doc) : null;
  }

  async findAwarded(): Promise<Tender[]> {
    const docs = await this.tenders
      .find({ status: 'closed', winners: { $ne: null, $not: { $size: 0 } } })
      .toArray();
    return docs.map(fromDoc);
  }

  async hasSource(source: string): Promise<boolean> {
    return (await this.sourceMeta.findOne({ _id: source })) !== null;
  }

  async getSourceCount(source: string): Promise<number> {
    return this.tenders.countDocuments({ 'sources.source': source });
  }

  async mergeMany(patches: TenderPatch[]): Promise<void> {
    for (const patch of patches) await this.mergeOne(patch);
  }

  // Derives status from dates already on the record: flips `open` -> `closed` once the
  // closing-date cutoff (or, lacking one, the one-month-past-advertised fallback) has
  // passed. Never touches provenance — this is a correction, not an observation.
  async reconcileStaleOpen(now: Date = new Date()): Promise<number> {
    const openDocs = await this.tenders.find({ status: 'open' }).toArray();
    const staleIds: string[] = [];
    for (const doc of openDocs) {
      if (doc.closingDate) {
        if (now >= closingCutoff(doc.closingDate)) staleIds.push(doc._id);
      } else if (doc.advertisedDate) {
        if (now > addOneMonth(doc.advertisedDate)) staleIds.push(doc._id);
      }
    }
    if (staleIds.length === 0) return 0;
    await this.tenders.updateMany({ _id: { $in: staleIds } }, { $set: { status: 'closed' } });
    return staleIds.length;
  }

  private async mergeOne(patch: TenderPatch): Promise<void> {
    const key = patch.dedupKey;
    const existing = await this.tenders.findOne({ _id: key });

    if (!existing) {
      const seeded: Tender = {
        dedupKey: key,
        referenceNo: patch.referenceNo,
        title: patch.title,
        status: patch.status,
        procurementType: patch.procurementType,
        ministry: patch.ministry ?? null,
        agency: patch.agency ?? null,
        category: patch.category ?? null,
        fieldCodes: patch.fieldCodes ?? [],
        advertisedDate: patch.advertisedDate ?? null,
        closingDate: patch.closingDate ?? null,
        indicativePrice: patch.indicativePrice ?? null,
        currency: 'MYR',
        events: patch.events ?? [],
        winners: patch.winners ?? null,
        raw: patch.raw ?? {},
        scrapedAt: patch.scrapedAt,
        sources: [patch.source],
      };
      const prov: Record<string, string> = {};
      for (const field of Object.keys(patch)) {
        if (field === 'dedupKey' || field === 'source') continue;
        prov[field] = patch.scrapedAt;
      }
      await this.tenders.replaceOne({ _id: key }, toDoc(seeded, prov), { upsert: true });
      return;
    }

    const merged = fromDoc(existing);
    const prov = { ...existing._provenance };
    const mutable = merged as unknown as Record<string, unknown>;

    for (const [field, value] of Object.entries(patch)) {
      if (field === 'dedupKey' || field === 'source') continue;
      if (value === undefined) continue; // this job didn't observe this field

      if (value === null && NULLABLE_FIELDS.has(field) && mutable[field] != null) {
        continue; // never let "no information" clobber a known value
      }

      const lastWrite = prov[field];
      if (lastWrite !== undefined && patch.scrapedAt < lastWrite) continue; // stale/out-of-order patch

      mutable[field] = value;
      prov[field] = patch.scrapedAt;
    }

    const srcIdx = merged.sources.findIndex((s) => s.source === patch.source.source);
    if (srcIdx === -1) merged.sources.push(patch.source);
    else merged.sources[srcIdx] = patch.source;

    await this.tenders.replaceOne({ _id: key }, toDoc(merged, prov), { upsert: true });
  }

  async getMeta(source: string): Promise<SourceMeta> {
    const doc = await this.sourceMeta.findOne({ _id: source });
    if (!doc) return { ...DEFAULT_META };
    const { _id, ...meta } = doc;
    return { ...DEFAULT_META, ...meta };
  }

  async setMeta(source: string, patch: Partial<SourceMeta>): Promise<void> {
    const merged = { ...(await this.getMeta(source)), ...patch };
    await this.sourceMeta.replaceOne({ _id: source }, { _id: source, ...merged }, { upsert: true });
  }
}

// 12:01pm Malaysia time (UTC+8, no DST) on the given YYYY-MM-DD closing date — every
// submission is due before noon that day, so anything at or after this instant is closed.
function closingCutoff(dateStr: string): Date {
  return new Date(`${dateStr}T12:01:00+08:00`);
}

// Same calendar day one month later (e.g. 2026-01-15 -> 2026-02-15, at midnight MYT), used
// as a fallback deadline for records where a real closing date was never captured. Clamps
// to the target month's last day when the original day doesn't exist there (e.g.
// 2026-01-31 -> 2026-02-28, never overflowing into March).
function addOneMonth(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  let targetYear = year;
  let targetMonth = month + 1; // 1-12, may be 13
  if (targetMonth > 12) {
    targetMonth = 1;
    targetYear += 1;
  }
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const targetDay = Math.min(day, daysInTargetMonth);
  const pad = (n: number) => String(n).padStart(2, '0');
  return new Date(`${targetYear}-${pad(targetMonth)}-${pad(targetDay)}T00:00:00+08:00`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w backend -- repository.test`
Expected: PASS, all 24 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/storage/repository.ts backend/test/repository.test.ts
git commit -m "feat: rewrite TenderRepository against Mongo collections"
```

---

### Task 3: Delete `resolveDataDir.ts` and its test

**Files:**
- Delete: `backend/src/resolveDataDir.ts`
- Delete: `backend/test/resolveDataDir.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — `resolveDataDir` is no longer imported by anyone after Task 9 rewrites `index.ts`. This task only deletes the now-dead file; do it now so Task 9's `index.ts` rewrite doesn't reference a stale import, and so an accidental leftover import elsewhere is caught by TypeScript immediately.

- [ ] **Step 1: Confirm nothing outside `index.ts` imports it**

Run: `grep -rl "resolveDataDir" backend/src backend/test`
Expected output: only `backend/src/resolveDataDir.ts`, `backend/test/resolveDataDir.test.ts`, and `backend/src/index.ts` (the last one is rewritten in Task 9 — leave its import broken until then; TypeScript will flag it, which is fine since Task 9 runs before the next full-suite check).

- [ ] **Step 2: Delete the files**

```bash
git rm backend/src/resolveDataDir.ts backend/test/resolveDataDir.test.ts
```

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: remove resolveDataDir (no on-disk data directory once Mongo lands)"
```

Note: `npm test` will fail after this commit because `backend/src/index.ts` still imports the deleted module — that's expected and gets fixed in Task 9. Do not run the full suite as a gate here; the per-task gate resumes at Task 4 (which doesn't touch `index.ts`).

---

### Task 4: Rewrite `dailyRunState` against a `schedulerState` collection

**Files:**
- Modify: `backend/src/scheduler/dailyRunState.ts` (full rewrite)
- Modify: `backend/test/dailyRunState.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `QueryableCollection<T>` from `backend/src/storage/tenderDoc.js` (Task 1); `FakeCollection` from `backend/test/support/fakeMongoCollection.js` (Task 1).
- Produces: `createDailyRunStateStore(collection: QueryableCollection<SchedulerStateDoc>): { load(): Promise<string|null>; save(date): Promise<void> }`. Consumed by Task 9 (`index.ts`).

- [ ] **Step 1: Write the failing test — replace `backend/test/dailyRunState.test.ts` in full**

```ts
import { describe, expect, it } from 'vitest';
import { createDailyRunStateStore } from '../src/scheduler/dailyRunState.js';
import type { SchedulerStateDoc } from '../src/scheduler/dailyRunState.js';
import { FakeCollection } from './support/fakeMongoCollection.js';

describe('createDailyRunStateStore', () => {
  it('load() returns null when no state document exists yet', async () => {
    const store = createDailyRunStateStore(new FakeCollection<SchedulerStateDoc>());
    expect(await store.load()).toBeNull();
  });

  it('save() then load() round-trips the date', async () => {
    const store = createDailyRunStateStore(new FakeCollection<SchedulerStateDoc>());
    await store.save('2026-07-11');
    expect(await store.load()).toBe('2026-07-11');
  });

  it('save() overwrites a previously saved date', async () => {
    const store = createDailyRunStateStore(new FakeCollection<SchedulerStateDoc>());
    await store.save('2026-07-10');
    await store.save('2026-07-11');
    expect(await store.load()).toBe('2026-07-11');
  });

  it('a second store backed by the same underlying collection sees a saved date', async () => {
    const collection = new FakeCollection<SchedulerStateDoc>();
    const store1 = createDailyRunStateStore(collection);
    await store1.save('2026-07-11');
    const store2 = createDailyRunStateStore(collection);
    expect(await store2.load()).toBe('2026-07-11');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w backend -- dailyRunState.test`
Expected: FAIL — `createDailyRunStateStore` still takes a `dataDir` string, `SchedulerStateDoc` doesn't exist.

- [ ] **Step 3: Replace `backend/src/scheduler/dailyRunState.ts` in full**

```ts
import type { QueryableCollection } from '../storage/tenderDoc.js';

export interface SchedulerStateDoc {
  _id: 'daily';
  lastRunDate: string | null;
}

export function createDailyRunStateStore(collection: QueryableCollection<SchedulerStateDoc>) {
  return {
    async load(): Promise<string | null> {
      const doc = await collection.findOne({ _id: 'daily' });
      return doc?.lastRunDate ?? null;
    },
    async save(date: string): Promise<void> {
      await collection.replaceOne({ _id: 'daily' }, { _id: 'daily', lastRunDate: date }, { upsert: true });
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w backend -- dailyRunState.test`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/scheduler/dailyRunState.ts backend/test/dailyRunState.test.ts
git commit -m "feat: rewrite dailyRunState against a Mongo schedulerState collection"
```

---

### Task 5: Rewrite `queryTenders`/`buildFacets` as Mongo query/aggregation builders

**Files:**
- Modify: `backend/src/query/tenders.ts` (full rewrite)
- Modify: `backend/test/query.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `TenderDoc`, `fromDoc`, `QueryableCollection<T>` from `backend/src/storage/tenderDoc.js` (Task 1); `FakeCollection` from `backend/test/support/fakeMongoCollection.js` (Task 1).
- Produces: `TenderQuery`, `TenderPage`, `Facets` types (unchanged shape); `buildMatchStage(q: TenderQuery): Record<string,unknown>`; `async queryTenders(collection: QueryableCollection<TenderDoc>, q: TenderQuery): Promise<TenderPage>`; `async buildFacets(collection: QueryableCollection<TenderDoc>): Promise<Facets>`. Consumed by Task 7 (`app.ts`).

- [ ] **Step 1: Write the failing test — replace `backend/test/query.test.ts` in full**

```ts
import { describe, expect, it } from 'vitest';
import type { Tender } from '@tms/shared';
import { buildFacets, queryTenders } from '../src/query/tenders.js';
import type { TenderDoc } from '../src/storage/tenderDoc.js';
import { toDoc } from '../src/storage/tenderDoc.js';
import { FakeCollection } from './support/fakeMongoCollection.js';

let seq = 0;
function t(overrides: Partial<Tender> = {}): Tender {
  seq += 1;
  return {
    dedupKey: `REF/${seq}`, referenceNo: `REF/${seq}`, title: `TENDER ${seq}`,
    status: 'open', procurementType: 'quotation',
    ministry: 'KEMENTERIAN A', agency: 'AGENSI A', category: 'Bekalan', fieldCodes: [],
    advertisedDate: '2026-07-01', closingDate: '2026-07-15', indicativePrice: 1000,
    currency: 'MYR', events: [], winners: null, raw: {}, scrapedAt: '2026-07-07T00:00:00.000Z',
    sources: [{ source: 'myprocurement', sourceId: String(seq), sourceUrl: `https://example.com/${seq}` }],
    ...overrides,
  };
}

async function collectionOf(tenders: Tender[]): Promise<FakeCollection<TenderDoc>> {
  const col = new FakeCollection<TenderDoc>();
  for (const tender of tenders) {
    await col.replaceOne({ _id: tender.dedupKey }, toDoc(tender, {}), { upsert: true });
  }
  return col;
}

describe('queryTenders', () => {
  it('searches title and referenceNo case-insensitively', async () => {
    const col = await collectionOf([t({ title: 'MEMBINA BUMBUNG' }), t({ referenceNo: 'KP/STRIDE/26', dedupKey: 'KP/STRIDE/26' }), t()]);
    expect((await queryTenders(col, { search: 'bumbung' })).items).toHaveLength(1);
    expect((await queryTenders(col, { search: 'stride' })).items).toHaveLength(1);
  });

  it('filters by every supported field', async () => {
    const col = await collectionOf([
      t({ ministry: 'KEMENTERIAN B' }),
      t({ status: 'closed' }),
      t({ procurementType: 'tender' }),
      t({ agency: 'AGENSI B' }),
      t({ category: 'Kerja' }),
      t({ fieldCodes: ['220801'] }),
      t({ winners: [{ name: 'X', price: 1 }] }),
    ]);
    expect((await queryTenders(col, { ministry: 'KEMENTERIAN B' })).total).toBe(1);
    expect((await queryTenders(col, { status: 'closed' })).total).toBe(1);
    expect((await queryTenders(col, { procurementType: 'tender' })).total).toBe(1);
    expect((await queryTenders(col, { agency: 'AGENSI B' })).total).toBe(1);
    expect((await queryTenders(col, { category: 'Kerja' })).total).toBe(1);
    expect((await queryTenders(col, { hasWinners: true })).total).toBe(1);
  });

  it('filters by field code prefix at any level', async () => {
    const col = await collectionOf([
      t({ fieldCodes: ['220801'] }),
      t({ fieldCodes: ['010101'] }),
      t({ fieldCodes: ['220899'] }),
    ]);
    expect((await queryTenders(col, { fieldCode: '22' })).total).toBe(2);
    expect((await queryTenders(col, { fieldCode: '2208' })).total).toBe(2);
    expect((await queryTenders(col, { fieldCode: '220801' })).total).toBe(1);
    expect((await queryTenders(col, { fieldCode: '21' })).total).toBe(0);
  });

  it('treats hasWinners as "winners is a non-empty array", not merely non-null', async () => {
    const col = await collectionOf([t({ winners: [] }), t({ winners: [{ name: 'X', price: null }] }), t({ winners: null })]);
    expect((await queryTenders(col, { hasWinners: true })).total).toBe(1);
  });

  it('filters by contractor name (case-insensitive substring), matching any winner on the tender', async () => {
    const col = await collectionOf([
      t({ winners: [{ name: 'SAFWORKS SDN. BHD.', price: 100 }] }),
      t({ winners: [{ name: 'BBL GLOBAL ENTERPRISE', price: 200 }, { name: 'SAFWORKS SDN. BHD.', price: 50 }] }),
      t({ winners: [{ name: 'SUCEME ENTERPRISE', price: 300 }] }),
      t({ winners: null }),
    ]);
    expect((await queryTenders(col, { contractor: 'SAFWORKS SDN. BHD.' })).total).toBe(2);
    expect((await queryTenders(col, { contractor: 'safworks' })).total).toBe(2);
    expect((await queryTenders(col, { contractor: 'SUCEME' })).total).toBe(1);
    expect((await queryTenders(col, { contractor: 'NOBODY' })).total).toBe(0);
  });

  it('filters by source, matching a tender that has the source among possibly several', async () => {
    const col = await collectionOf([
      t({ sources: [{ source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1' }] }),
      t({ sources: [
        { source: 'myprocurement', sourceId: '2', sourceUrl: 'https://example.com/2' },
        { source: 'span', sourceId: '9', sourceUrl: 'https://example.com/9' },
      ] }),
      t({ sources: [{ source: 'kwsp', sourceId: 'Doc1', sourceUrl: 'https://example.com/kwsp/1' }] }),
    ]);
    expect((await queryTenders(col, { source: 'span' })).total).toBe(1);
    expect((await queryTenders(col, { source: 'myprocurement' })).total).toBe(2);
    expect((await queryTenders(col, { source: 'kwsp' })).total).toBe(1);
    expect((await queryTenders(col, { source: 'nonexistent' })).total).toBe(0);
  });

  it('filters by closingFrom, inclusive, excluding tenders with a null closingDate', async () => {
    const col = await collectionOf([
      t({ closingDate: '2026-07-10' }), t({ closingDate: '2026-07-15' }),
      t({ closingDate: '2026-07-20' }), t({ closingDate: null }),
    ]);
    expect((await queryTenders(col, { closingFrom: '2026-07-15' })).total).toBe(2);
    expect((await queryTenders(col, { closingFrom: '2026-07-10' })).total).toBe(3);
  });

  it('filters by closingTo, inclusive, excluding tenders with a null closingDate', async () => {
    const col = await collectionOf([
      t({ closingDate: '2026-07-10' }), t({ closingDate: '2026-07-15' }),
      t({ closingDate: '2026-07-20' }), t({ closingDate: null }),
    ]);
    expect((await queryTenders(col, { closingTo: '2026-07-15' })).total).toBe(2);
    expect((await queryTenders(col, { closingTo: '2026-07-20' })).total).toBe(3);
  });

  it('filters by closingFrom and closingTo together as an inclusive range', async () => {
    const col = await collectionOf([
      t({ closingDate: '2026-07-05' }), t({ closingDate: '2026-07-15' }),
      t({ closingDate: '2026-07-25' }), t({ closingDate: null }),
    ]);
    const page = await queryTenders(col, { closingFrom: '2026-07-10', closingTo: '2026-07-20' });
    expect(page.total).toBe(1);
    expect(page.items[0]!.closingDate).toBe('2026-07-15');
  });

  it('sorts by price desc with nulls last, paginates with total', async () => {
    const col = await collectionOf([t({ indicativePrice: 5 }), t({ indicativePrice: null }), t({ indicativePrice: 99 })]);
    const page = await queryTenders(col, { sortBy: 'indicativePrice', sortOrder: 'desc', page: 1, pageSize: 2 });
    expect(page.items.map((x) => x.indicativePrice)).toEqual([99, 5]);
    expect(page.total).toBe(3);
    const page2 = await queryTenders(col, { sortBy: 'indicativePrice', sortOrder: 'desc', page: 2, pageSize: 2 });
    expect(page2.items.map((x) => x.indicativePrice)).toEqual([null]);
  });

  it('defaults: sorted by advertisedDate desc, page 1, pageSize 20, pageSize capped at 100', async () => {
    const col = await collectionOf([t({ advertisedDate: '2026-01-01' }), t({ advertisedDate: '2026-06-01' })]);
    const page = await queryTenders(col, {});
    expect(page.items[0]!.advertisedDate).toBe('2026-06-01');
    expect(page.pageSize).toBe(20);
    expect((await queryTenders(col, { pageSize: 5000 })).pageSize).toBe(100);
  });
});

describe('buildFacets', () => {
  it('returns sorted distinct values, omitting nulls, including fieldCodes and sources', async () => {
    const col = await collectionOf([
      t({
        ministry: 'Z', agency: null, category: 'Kerja', procurementType: 'tender', fieldCodes: ['220801', '010101'],
        sources: [{ source: 'span', sourceId: '1', sourceUrl: 'https://example.com/1' }],
      }),
      t({ ministry: 'A', fieldCodes: ['010101'] }),
      t({ ministry: 'A' }),
    ]);
    const f = await buildFacets(col);
    expect(f.ministries).toEqual(['A', 'Z']);
    expect(f.agencies).toEqual(['AGENSI A']);
    expect(f.procurementTypes).toEqual(['quotation', 'tender']);
    expect(f.fieldCodes).toEqual(['010101', '220801']);
    expect(f.sources).toEqual(['myprocurement', 'span']);
  });
});
```

Note: the original test "does not mutate the input array while sorting" is dropped — `queryTenders` no longer takes an array it could mutate; it builds a query against a collection, so this concern doesn't apply to the Mongo-backed version.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w backend -- query.test`
Expected: FAIL — `queryTenders`/`buildFacets` still take a `Tender[]` synchronously.

- [ ] **Step 3: Replace `backend/src/query/tenders.ts` in full**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w backend -- query.test`
Expected: PASS, all 12 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/query/tenders.ts backend/test/query.test.ts
git commit -m "feat: rewrite queryTenders/buildFacets as Mongo query/aggregation builders"
```

---

### Task 6: Confirm `buildDashboardStats` needs no code changes

**Files:**
- None modified — this task is a verification step, not a code change.

**Interfaces:**
- Consumes: nothing new. `buildDashboardStats(tenders: Tender[]): DashboardStats` in `backend/src/query/dashboard.ts` keeps its exact current signature per the design spec (its contractor-normalization logic doesn't belong in a database query).
- Produces: nothing new — Task 7 wires its caller in `app.ts` to `await deps.repo.findAwarded()` instead of `deps.repo.getAll()`.

- [ ] **Step 1: Run the existing dashboard tests to confirm they still pass untouched**

Run: `npm test -w backend -- dashboard.test`
Expected: PASS, all existing tests green with zero changes to `backend/src/query/dashboard.ts` or `backend/test/dashboard.test.ts` — confirms this file is genuinely unaffected by the storage swap, per the "hybrid" design decision.

(No commit — nothing changed.)

---

### Task 7: Update `api/app.ts` for async repository/query calls, wire `findAwarded`

**Files:**
- Modify: `backend/src/api/app.ts`
- Modify: `backend/test/app.test.ts`

**Interfaces:**
- Consumes: `TenderRepository` (Task 2, all methods now async), `queryTenders`/`buildFacets` (Task 5, now `(collection, q)` and async), `buildDashboardStats` (Task 6, unchanged), `ScrapeManager.listSources()` (Task 8, becomes async), `ScrapeManager.refreshResults()` (Task 8, becomes async).
- Produces: `createApp(deps: { repo: TenderRepository; tendersCollection: QueryableCollection<TenderDoc>; manager: ScrapeManager })` — note the new `tendersCollection` dependency, needed because `queryTenders`/`buildFacets` operate on the raw collection, not the repository. Consumed by Task 9 (`index.ts`) and by this task's own test file.

- [ ] **Step 1: Write the failing test — replace `backend/test/app.test.ts` in full**

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TenderPatch } from '@tms/shared';
import { createApp } from '../src/api/app.js';
import { ScrapeManager } from '../src/scrape/manager.js';
import type { ScrapeHooks } from '../src/scrapers/types.js';
import { TenderRepository } from '../src/storage/repository.js';
import type { SourceMetaDoc } from '../src/storage/repository.js';
import type { TenderDoc } from '../src/storage/tenderDoc.js';
import { FakeCollection } from './support/fakeMongoCollection.js';

let seq = 0;
function patch(overrides: Partial<TenderPatch> = {}): TenderPatch {
  seq += 1;
  return {
    dedupKey: `REF/${seq}`, referenceNo: `REF/${seq}`, title: `TENDER ${seq}`,
    status: 'open', procurementType: 'quotation',
    scrapedAt: '2026-07-07T00:00:00.000Z',
    source: { source: 'myprocurement', sourceId: String(seq), sourceUrl: `https://example.com/${seq}` },
    ministry: 'KEMENTERIAN A', agency: null, category: null, fieldCodes: [],
    advertisedDate: '2026-07-01', closingDate: null, indicativePrice: null,
    ...overrides,
  };
}

async function waitUntilNotRunning(app: ReturnType<typeof createApp>): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const res = await request(app).get('/api/scrape/status');
    if (res.body.state !== 'running') return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitUntilNotRunning: timed out');
}

describe('API', () => {
  let tendersCollection: FakeCollection<TenderDoc>;
  let repo: TenderRepository;
  let manager: ScrapeManager;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    tendersCollection = new FakeCollection<TenderDoc>();
    repo = new TenderRepository(tendersCollection, new FakeCollection<SourceMetaDoc>());
    manager = new ScrapeManager([], repo);
    app = createApp({ repo, tendersCollection, manager });
  });

  it('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api/tenders returns paginated, filterable results', async () => {
    await repo.mergeMany([patch({ title: 'BUMBUNG GELANGGANG' }), patch({ status: 'closed' }), patch()]);
    const all = await request(app).get('/api/tenders');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.page).toBe(1);

    const filtered = await request(app).get('/api/tenders?status=closed');
    expect(filtered.body.total).toBe(1);

    const searched = await request(app).get('/api/tenders?search=bumbung');
    expect(searched.body.total).toBe(1);
  });

  it('GET /api/tenders supports fieldCode and hasWinners filters', async () => {
    await repo.mergeMany([
      patch({ fieldCodes: ['220801'] }),
      patch({ winners: [{ name: 'X', price: 1 }] }),
      patch(),
    ]);
    const byField = await request(app).get('/api/tenders?fieldCode=22');
    expect(byField.body.total).toBe(1);
    const awarded = await request(app).get('/api/tenders?hasWinners=true');
    expect(awarded.body.total).toBe(1);
  });

  it('GET /api/tenders supports a contractor filter matching any winner name', async () => {
    await repo.mergeMany([
      patch({ winners: [{ name: 'SAFWORKS SDN. BHD.', price: 1 }] }),
      patch({ winners: [{ name: 'SUCEME ENTERPRISE', price: 2 }] }),
      patch(),
    ]);
    const res = await request(app).get('/api/tenders?contractor=SAFWORKS SDN. BHD.');
    expect(res.body.total).toBe(1);
  });

  it('GET /api/tenders supports closingFrom and closingTo as an inclusive date range', async () => {
    await repo.mergeMany([
      patch({ closingDate: '2026-07-05' }),
      patch({ closingDate: '2026-07-15' }),
      patch({ closingDate: '2026-07-25' }),
    ]);
    const res = await request(app).get('/api/tenders?closingFrom=2026-07-10&closingTo=2026-07-20');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it('GET /api/tenders?hasWinners=false returns unfiltered results, not awarded-only', async () => {
    await repo.mergeMany([patch({ winners: [{ name: 'X', price: 1 }] }), patch(), patch()]);
    const res = await request(app).get('/api/tenders?hasWinners=false');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });

  it('GET /api/tenders rejects invalid query params with 400', async () => {
    const res = await request(app).get('/api/tenders?status=maybe');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('GET /api/tenders/facets returns distinct values including fieldCodes', async () => {
    await repo.mergeMany([patch(), patch({ ministry: 'KEMENTERIAN B', fieldCodes: ['010101'] })]);
    const res = await request(app).get('/api/tenders/facets');
    expect(res.status).toBe(200);
    expect(res.body.ministries).toEqual(['KEMENTERIAN A', 'KEMENTERIAN B']);
    expect(res.body.fieldCodes).toEqual(['010101']);
  });

  it('GET /api/dashboard returns awarded-tender aggregate stats', async () => {
    await repo.mergeMany([
      patch({
        status: 'closed', ministry: 'KEMENTERIAN A', closingDate: '2025-01-10',
        winners: [{ name: 'ACME SDN BHD', price: 500 }],
      }),
      patch({ status: 'open' }),
    ]);
    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.totalAwardedCount).toBe(1);
    expect(res.body.totalAwardedValue).toBe(500);
    expect(res.body.byMinistry).toEqual([{ ministry: 'KEMENTERIAN A', totalValue: 500, count: 1 }]);
  });

  it('GET /api/tenders/:refNo returns { tender } by reference number; 404 when missing', async () => {
    await repo.mergeMany([patch({ dedupKey: 'UTHM/54/P/02', referenceNo: 'UTHM/54/P/02' })]);
    const res = await request(app).get(`/api/tenders/${encodeURIComponent('UTHM/54/P/02')}`);
    expect(res.status).toBe(200);
    expect(res.body.tender.referenceNo).toBe('UTHM/54/P/02');

    const missing = await request(app).get('/api/tenders/NOPE');
    expect(missing.status).toBe(404);
  });

  it('POST /api/scrape starts an open-scope scrape (202) and 409s while running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let receivedScope: string | undefined;
    const blockingManager = new ScrapeManager(
      [{ name: 'fake', scrape: async (scope: string, _h: ScrapeHooks) => { receivedScope = scope; await gate; }, archiveJobNames: () => [] }],
      repo,
    );
    const app2 = createApp({ repo, tendersCollection, manager: blockingManager });

    const first = await request(app2).post('/api/scrape');
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ started: true });
    expect(receivedScope).toBe('open');

    const second = await request(app2).post('/api/scrape');
    expect(second.status).toBe(409);

    const status = await request(app2).get('/api/scrape/status');
    expect(status.body.state).toBe('running');
    release();
  });

  it('GET /api/scrape/status is idle initially', async () => {
    const res = await request(app).get('/api/scrape/status');
    expect(res.body).toEqual({ state: 'idle' });
  });

  it('GET /api/sources returns name, lastScrapedAt, lastArchiveBackfillAt, and total per registered adapter', async () => {
    const fakeAdapter = { name: 'span', scrape: async () => {}, archiveJobNames: () => [] };
    const mgr = new ScrapeManager([fakeAdapter], repo);
    const app2 = createApp({ repo, tendersCollection, manager: mgr });
    const res = await request(app2).get('/api/sources');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ name: 'span', lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 }]);
  });

  it('POST /api/scrape accepts source and scope=full, running only that adapter with the manager\'s "all" scope', async () => {
    const scrapedBy: string[] = [];
    let receivedScope: string | undefined;
    const adapterA = { name: 'a', scrape: async () => { scrapedBy.push('a'); }, archiveJobNames: () => [] };
    const adapterB = {
      name: 'b',
      scrape: async (scope: string) => { scrapedBy.push('b'); receivedScope = scope; },
      archiveJobNames: () => [],
    };
    const mgr = new ScrapeManager([adapterA, adapterB], repo);
    const app2 = createApp({ repo, tendersCollection, manager: mgr });
    const res = await request(app2).post('/api/scrape').send({ source: 'b', scope: 'full' });
    expect(res.status).toBe(202);
    await waitUntilNotRunning(app2);
    expect(scrapedBy).toEqual(['b']);
    expect(receivedScope).toBe('all');
  });

  it('POST /api/scrape rejects an invalid scope value with 400', async () => {
    const res = await request(app).post('/api/scrape').send({ scope: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('POST /api/scrape with scope=results refreshes only that source\'s results jobs (202), and 409s when the adapter has none', async () => {
    await repo.setMeta('myprocurement', { completedArchiveJobs: ['closed-quotation', 'closed-quotation-results'] });
    const scrapedScopes: string[] = [];
    const adapter = {
      name: 'myprocurement',
      scrape: async (scope: string) => { scrapedScopes.push(scope); },
      archiveJobNames: () => ['closed-quotation', 'closed-quotation-results'],
      resultsJobNames: () => ['closed-quotation-results'],
    };
    const mgr = new ScrapeManager([adapter], repo);
    const app2 = createApp({ repo, tendersCollection, manager: mgr });

    const res = await request(app2).post('/api/scrape').send({ source: 'myprocurement', scope: 'results' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ started: true });
    await waitUntilNotRunning(app2);
    expect(scrapedScopes).toEqual(['archive']);
    expect((await repo.getMeta('myprocurement')).completedArchiveJobs).toEqual(['closed-quotation']);

    const noResultsAdapter = { name: 'span', scrape: async () => {}, archiveJobNames: () => [], resultsJobNames: () => [] };
    const mgr2 = new ScrapeManager([noResultsAdapter], repo);
    const app3 = createApp({ repo, tendersCollection, manager: mgr2 });
    const res2 = await request(app3).post('/api/scrape').send({ source: 'span', scope: 'results' });
    expect(res2.status).toBe(409);
  });

  it('POST /api/scrape with scope=results and no source returns 400', async () => {
    const res = await request(app).post('/api/scrape').send({ scope: 'results' });
    expect(res.status).toBe(400);
  });

  it('POST /api/scrape/cancel cancels a running scrape (200) and 409s when nothing is running', async () => {
    const idle = await request(app).post('/api/scrape/cancel');
    expect(idle.status).toBe(409);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const blockingAdapter = { name: 'fake', scrape: async () => { await gate; }, archiveJobNames: () => [] };
    const blockingManager = new ScrapeManager([blockingAdapter], repo);
    const app2 = createApp({ repo, tendersCollection, manager: blockingManager });
    await request(app2).post('/api/scrape');
    const res = await request(app2).post('/api/scrape/cancel');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: true });
    release();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w backend -- app.test`
Expected: FAIL — `createApp` doesn't accept `tendersCollection`, route handlers call sync methods on now-async repo/manager.

- [ ] **Step 3: Replace `backend/src/api/app.ts` in full**

```ts
import express from 'express';
import { z } from 'zod';
import { computeDedupKey } from '@tms/shared';
import type { ScrapeManager } from '../scrape/manager.js';
import type { TenderRepository } from '../storage/repository.js';
import type { QueryableCollection, TenderDoc } from '../storage/tenderDoc.js';
import { buildFacets, queryTenders } from '../query/tenders.js';
import { buildDashboardStats } from '../query/dashboard.js';

const ScrapeRequestSchema = z.object({
  source: z.string().optional(),
  scope: z.enum(['open', 'full', 'results']).optional(),
});

const QuerySchema = z.object({
  search: z.string().optional(),
  ministry: z.string().optional(),
  agency: z.string().optional(),
  category: z.string().optional(),
  source: z.string().optional(),
  closingFrom: z.string().optional(),
  closingTo: z.string().optional(),
  status: z.enum(['open', 'closed']).optional(),
  procurementType: z.enum(['quotation', 'tender', 'requisition']).optional(),
  fieldCode: z.string().optional(),
  hasWinners: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  contractor: z.string().optional(),
  sortBy: z.enum(['advertisedDate', 'closingDate', 'indicativePrice']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
});

export function createApp(deps: {
  repo: TenderRepository;
  tendersCollection: QueryableCollection<TenderDoc>;
  manager: ScrapeManager;
}) {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/sources', async (_req, res) => {
    res.json(await deps.manager.listSources());
  });

  app.get('/api/tenders/facets', async (_req, res) => {
    res.json(await buildFacets(deps.tendersCollection));
  });

  app.get('/api/dashboard', async (_req, res) => {
    res.json(buildDashboardStats(await deps.repo.findAwarded()));
  });

  app.get('/api/tenders/:refNo', async (req, res) => {
    const key = computeDedupKey(req.params.refNo, req.params.refNo);
    const tender = await deps.repo.findByDedupKey(key);
    if (!tender) return res.status(404).json({ error: 'tender not found' });
    res.json({ tender });
  });

  app.get('/api/tenders', async (req, res) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.json(await queryTenders(deps.tendersCollection, parsed.data));
  });

  app.post('/api/scrape', async (req, res) => {
    const parsed = ScrapeRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    if (parsed.data.scope === 'results') {
      if (!parsed.data.source) return res.status(400).json({ error: 'source is required for scope=results' });
      const started = await deps.manager.refreshResults(parsed.data.source);
      if (!started) return res.status(409).json({ error: 'cannot refresh results for this source' });
      return res.status(202).json({ started: true });
    }
    const scope = parsed.data.scope === 'full' ? 'all' : 'open';
    const started = deps.manager.start(scope, { sourceName: parsed.data.source });
    if (!started) return res.status(409).json({ error: 'scrape already running' });
    res.status(202).json({ started: true });
  });

  app.post('/api/scrape/cancel', (_req, res) => {
    if (!deps.manager.cancel()) return res.status(409).json({ error: 'nothing running' });
    res.json({ cancelled: true });
  });

  app.get('/api/scrape/status', (_req, res) => {
    res.json(deps.manager.status());
  });

  return app;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w backend -- app.test`
Expected: still FAIL at this point — `ScrapeManager.listSources()`/`refreshResults()` aren't async yet (Task 8). This is expected; proceed to Task 8 before re-running.

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/app.ts backend/test/app.test.ts
git commit -m "feat: make API routes async, wire findAwarded and tendersCollection into app.ts"
```

Note: this commit leaves `npm test` red until Task 8 lands — acceptable here because Tasks 7 and 8 are two halves of one ripple (async propagation) that cannot both be independently green; Task 8's own test run is the real gate. If you want a strictly-green history, merge Tasks 7 and 8 into a single commit instead — either is fine, but do not skip running the full suite at the end of Task 8.

---

### Task 8: Update `ScrapeManager` for async repository calls, remove `flush()` batching, fix `refreshResults` race window

**Files:**
- Modify: `backend/src/scrape/manager.ts`
- Modify: `backend/test/manager.test.ts`

**Interfaces:**
- Consumes: `TenderRepository` (Task 2, all methods async, no more `flush()`).
- Produces: `ScrapeManager` with `async listSources()`, `async refreshResults(sourceName): Promise<boolean>`, `start()` unchanged (still sync, still fire-and-forget via `void this.runToCompletion(...)`), constructor drops the `flushEveryPages`/`flushEveryPagesOpen`/`flushEveryPagesArchive` options (nothing left to batch — every `mergeMany` call already writes straight to Mongo). Consumed by Task 7 (`app.ts`, already wired) and Task 9 (`index.ts`).

- [ ] **Step 1: Write the failing test — replace `backend/test/manager.test.ts` in full**

```ts
import { describe, expect, it } from 'vitest';
import type { TenderPatch } from '@tms/shared';
import type { ScrapeHooks, ScrapeScope, ScraperAdapter } from '../src/scrapers/types.js';
import { TenderRepository } from '../src/storage/repository.js';
import type { SourceMetaDoc } from '../src/storage/repository.js';
import type { TenderDoc } from '../src/storage/tenderDoc.js';
import { FakeCollection } from './support/fakeMongoCollection.js';
import { ScrapeManager } from '../src/scrape/manager.js';

const NOW = () => '2026-07-07T12:00:00.000Z';

function makePatch(id: number): TenderPatch {
  return {
    dedupKey: `REF/${id}`, referenceNo: `REF/${id}`, title: `T${id}`,
    status: 'open', procurementType: 'quotation',
    scrapedAt: NOW(),
    source: { source: 'fake', sourceId: String(id), sourceUrl: `https://example.com/${id}` },
  };
}

function fakeAdapter(
  behavior: (scope: ScrapeScope, hooks: ScrapeHooks, opts?: import('../src/scrapers/types.js').ScrapeOptions) => Promise<void>,
  archiveJobNames: string[] = [],
  resultsJobNames: string[] = [],
): ScraperAdapter {
  return { name: 'fake', scrape: behavior, archiveJobNames: () => archiveJobNames, resultsJobNames: () => resultsJobNames };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function freshRepo(): TenderRepository {
  return new TenderRepository(new FakeCollection<TenderDoc>(), new FakeCollection<SourceMetaDoc>());
}

describe('ScrapeManager', () => {
  it('starts idle', () => {
    const mgr = new ScrapeManager([], freshRepo(), { now: NOW });
    expect(mgr.status()).toEqual({ state: 'idle' });
  });

  it('runs a scrape: merges batches, reports done, stamps lastScrapedAt and total', async () => {
    const repo = freshRepo();
    const adapter = fakeAdapter(async (_scope, hooks) => {
      hooks.onProgress({ source: 'fake', job: 'open-quotation', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1 });
      await hooks.onBatch([makePatch(1), makePatch(2)]);
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('open');
    expect(mgr.status().state).toBe('done');
    expect(await repo.getAll()).toHaveLength(2);
    expect((await repo.getMeta('fake')).lastScrapedAt).toBe(NOW());
    expect((await repo.getMeta('fake')).lastArchiveBackfillAt).toBeNull();
    expect((await repo.getMeta('fake')).total).toBe(2);
  });

  it('stamps lastArchiveBackfillAt when scope covers archive', async () => {
    const repo = freshRepo();
    const adapter = fakeAdapter(async () => {});
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('all');
    expect((await repo.getMeta('fake')).lastArchiveBackfillAt).toBe(NOW());
  });

  it('exposes live progress while running', async () => {
    const repo = freshRepo();
    let capturedMid: unknown;
    const adapter = fakeAdapter(async (_s, hooks) => {
      hooks.onProgress({ source: 'fake', job: 'open-tender', jobsCompleted: 1, jobsTotal: 3, currentPage: 12, lastPage: 96 });
      capturedMid = mgr.status();
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('open');
    expect(capturedMid).toEqual({
      state: 'running', source: 'fake', job: 'open-tender',
      jobsCompleted: 1, jobsTotal: 3, currentPage: 12, lastPage: 96,
    });
  });

  it("sets source on the running status as soon as an adapter starts, before its first progress tick", async () => {
    const repo = freshRepo();
    let capturedBeforeProgress: unknown;
    const adapter = fakeAdapter(async () => {
      capturedBeforeProgress = mgr.status();
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('open');
    expect(capturedBeforeProgress).toEqual({ state: 'running', source: 'fake' });
  });

  it('rejects concurrent starts', async () => {
    const repo = freshRepo();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const adapter = fakeAdapter(async () => gate);
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    expect(mgr.start('open')).toBe(true);
    expect(mgr.start('open')).toBe(false);
    release();
    await waitUntil(() => mgr.status().state !== 'running');
    expect(mgr.status().state).toBe('done');
  });

  it('passes previously-completed archive job names as skipJobNames, and persists onJobDone incrementally', async () => {
    const repo = freshRepo();
    await repo.setMeta('fake', { completedArchiveJobs: ['closed-quotation'] });
    const seenSkip: Set<string>[] = [];
    const adapter = fakeAdapter(async (_scope, hooks, opts) => {
      seenSkip.push(new Set(opts!.skipJobNames!));
      await hooks.onJobDone!('closed-tender');
      expect((await repo.getMeta('fake')).completedArchiveJobs).toEqual(['closed-quotation', 'closed-tender']);
      await hooks.onJobDone!('closed-requisition');
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('archive');
    expect(seenSkip[0]).toEqual(new Set(['closed-quotation']));
    expect((await repo.getMeta('fake')).completedArchiveJobs).toEqual(['closed-quotation', 'closed-tender', 'closed-requisition']);
  });

  it("refreshResults clears only that source's results job names, re-runs an archive scrape, and leaves other completed jobs untouched", async () => {
    const repo = freshRepo();
    await repo.setMeta('fake', {
      completedArchiveJobs: ['closed-quotation', 'closed-quotation-results', 'closed-tender-results'],
    });
    const seenScopes: ScrapeScope[] = [];
    let seenSkip: Set<string> | undefined;
    const adapter = fakeAdapter(
      async (scope, _hooks, opts) => { seenScopes.push(scope); seenSkip = opts?.skipJobNames; },
      [],
      ['closed-quotation-results', 'closed-tender-results'],
    );
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    expect(await mgr.refreshResults('fake')).toBe(true);
    await waitUntil(() => mgr.status().state === 'done');
    expect(seenScopes).toEqual(['archive']);
    expect(seenSkip).toEqual(new Set(['closed-quotation']));
    expect((await repo.getMeta('fake')).completedArchiveJobs).toEqual(['closed-quotation']);
  });

  it('refreshResults returns false when a scrape is already running, without touching completedArchiveJobs', async () => {
    const repo = freshRepo();
    await repo.setMeta('fake', { completedArchiveJobs: ['closed-quotation-results'] });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const adapter = fakeAdapter(async () => gate, [], ['closed-quotation-results']);
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    mgr.start('open');
    await waitUntil(() => mgr.status().state === 'running');
    expect(await mgr.refreshResults('fake')).toBe(false);
    expect((await repo.getMeta('fake')).completedArchiveJobs).toEqual(['closed-quotation-results']);
    release();
    await waitUntil(() => mgr.status().state !== 'running');
  });

  it('refreshResults returns false for a source name that matches no adapter', async () => {
    const mgr = new ScrapeManager([], freshRepo(), { now: NOW });
    expect(await mgr.refreshResults('nope')).toBe(false);
  });

  it('refreshResults returns false when the adapter has no results jobs to refresh', async () => {
    const adapter = fakeAdapter(async () => {}, [], []);
    const mgr = new ScrapeManager([adapter], freshRepo(), { now: NOW });
    expect(await mgr.refreshResults('fake')).toBe(false);
  });

  it('two concurrent refreshResults calls for the same source never both start a scrape', async () => {
    const repo = freshRepo();
    await repo.setMeta('fake', { completedArchiveJobs: ['closed-quotation-results'] });
    const adapter = fakeAdapter(async () => {}, [], ['closed-quotation-results']);
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    const [first, second] = await Promise.all([mgr.refreshResults('fake'), mgr.refreshResults('fake')]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it('sets failed state with error message; keeps previously merged batches', async () => {
    const repo = freshRepo();
    const adapter = fakeAdapter(async (_s, hooks) => {
      await hooks.onBatch([makePatch(1)]);
      throw new Error('fetch failed after 3 attempts: url');
    });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('open');
    expect(mgr.status().state).toBe('failed');
    expect(mgr.status().source).toBe('fake');
    expect(mgr.status().error).toContain('fetch failed');
    expect(await repo.getAll()).toHaveLength(1);
    expect((await repo.getMeta('fake')).lastScrapedAt).toBeNull();
  });

  it('runs only the named adapter when sourceName is given, leaving other adapters untouched', async () => {
    const repo = freshRepo();
    const calls: string[] = [];
    const adapterA: ScraperAdapter = { name: 'a', scrape: async () => { calls.push('a'); }, archiveJobNames: () => [] };
    const adapterB: ScraperAdapter = { name: 'b', scrape: async () => { calls.push('b'); }, archiveJobNames: () => [] };
    const mgr = new ScrapeManager([adapterA, adapterB], repo, { now: NOW });
    await mgr.runToCompletion('open', { sourceName: 'b' });
    expect(calls).toEqual(['b']);
  });

  it('listSources reports name, lastScrapedAt, lastArchiveBackfillAt, and total per adapter', async () => {
    const repo = freshRepo();
    const adapter = fakeAdapter(async (_s, hooks) => { await hooks.onBatch([makePatch(1)]); });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    expect(await mgr.listSources()).toEqual([{ name: 'fake', lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 }]);
    await mgr.runToCompletion('open');
    expect(await mgr.listSources()).toEqual([{ name: 'fake', lastScrapedAt: NOW(), lastArchiveBackfillAt: null, total: 1 }]);
  });

  it("cancel() stops a running scrape before the next adapter, keeps merged data, and reports state 'cancelled'", async () => {
    const repo = freshRepo();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let sawCancelled: boolean | undefined;
    const adapterA: ScraperAdapter = {
      name: 'a',
      scrape: async (_s, hooks, opts) => {
        await hooks.onBatch([makePatch(1)]);
        await gate;
        sawCancelled = opts?.isCancelled?.();
      },
      archiveJobNames: () => [],
    };
    const adapterB: ScraperAdapter = { name: 'b', scrape: async () => { throw new Error('b should never run'); }, archiveJobNames: () => [] };
    const mgr = new ScrapeManager([adapterA, adapterB], repo, { now: NOW });
    mgr.start('open');
    await waitUntil(() => mgr.status().state === 'running');
    expect(mgr.cancel()).toBe(true);
    release();
    await waitUntil(() => mgr.status().state !== 'running');
    expect(mgr.status().state).toBe('cancelled');
    expect(mgr.status().source).toBe('a');
    expect(sawCancelled).toBe(true);
    expect(await repo.getAll()).toHaveLength(1);
    expect((await repo.getMeta('a')).lastScrapedAt).toBeNull();
  });

  it('cancel() returns false when nothing is running', () => {
    const mgr = new ScrapeManager([], freshRepo(), { now: NOW });
    expect(mgr.cancel()).toBe(false);
  });

  it('waitUntilIdle resolves immediately when idle', async () => {
    const mgr = new ScrapeManager([], freshRepo(), { now: NOW });
    await expect(mgr.waitUntilIdle()).resolves.toBeUndefined();
  });

  it('waitUntilIdle resolves only after an in-flight run completes', async () => {
    const repo = freshRepo();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const adapter = fakeAdapter(async () => gate);
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    mgr.start('open');
    let resolved = false;
    const waiter = mgr.waitUntilIdle().then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    release();
    await waiter;
    expect(resolved).toBe(true);
    expect(mgr.status().state).toBe('done');
  });

  it('reconciles stale open tenders after the run completes', async () => {
    const repo = freshRepo();
    const stalePatch: TenderPatch = {
      dedupKey: 'STALE/1', referenceNo: 'STALE/1', title: 'Stale Tender',
      status: 'open', procurementType: 'quotation',
      scrapedAt: NOW(),
      closingDate: '2026-01-01',
      source: { source: 'fake', sourceId: '1', sourceUrl: 'https://example.com/1' },
    };
    const adapter = fakeAdapter(async (_s, hooks) => { await hooks.onBatch([stalePatch]); });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('open');
    expect((await repo.getAll())[0]!.status).toBe('closed');
  });

  it('leaves tenders open when reconciliation finds nothing stale', async () => {
    const repo = freshRepo();
    const freshPatch: TenderPatch = {
      dedupKey: 'FRESH/1', referenceNo: 'FRESH/1', title: 'Fresh Tender',
      status: 'open', procurementType: 'quotation',
      scrapedAt: NOW(),
      closingDate: '2026-12-31',
      source: { source: 'fake', sourceId: '1', sourceUrl: 'https://example.com/1' },
    };
    const adapter = fakeAdapter(async (_s, hooks) => { await hooks.onBatch([freshPatch]); });
    const mgr = new ScrapeManager([adapter], repo, { now: NOW });
    await mgr.runToCompletion('open');
    expect((await repo.getAll())[0]!.status).toBe('open');
  });
});
```

Note: the two removed tests ("defaults to a small flush interval...", plus the flush-count assertions inside the last two reconciliation tests) are gone because `flush()` no longer exists — there's nothing left to batch or count. A new test ("two concurrent refreshResults calls...") replaces that removed coverage with a check for the race window `Step 3` below closes.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w backend -- manager.test`
Expected: FAIL — `ScrapeManager` still has sync `getMeta`/`getSourceCount`/`listSources`/`refreshResults` calls against an async repository, and the `flushEveryPages` options/logic are still present but untested.

- [ ] **Step 3: Replace `backend/src/scrape/manager.ts` in full**

```ts
import type { ScrapeScope, ScraperAdapter } from '../scrapers/types.js';
import type { TenderRepository } from '../storage/repository.js';

export interface ScrapeStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  source?: string;
  job?: string;
  jobsCompleted?: number;
  jobsTotal?: number;
  currentPage?: number;
  lastPage?: number;
  error?: string;
}

export class ScrapeManager {
  private current: ScrapeStatus = { state: 'idle' };
  private running = false;
  private cancelRequested = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly adapters: ScraperAdapter[],
    private readonly repo: TenderRepository,
    private readonly opts: { now?: () => string } = {},
  ) {}

  status(): ScrapeStatus {
    return { ...this.current };
  }

  cancel(): boolean {
    if (!this.running) return false;
    this.cancelRequested = true;
    return true;
  }

  async waitUntilIdle(): Promise<void> {
    if (!this.running) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  async listSources(): Promise<Array<{ name: string; lastScrapedAt: string | null; lastArchiveBackfillAt: string | null; total: number }>> {
    return Promise.all(
      this.adapters.map(async (a) => {
        const meta = await this.repo.getMeta(a.name);
        return { name: a.name, lastScrapedAt: meta.lastScrapedAt, lastArchiveBackfillAt: meta.lastArchiveBackfillAt, total: meta.total };
      }),
    );
  }

  start(scope: ScrapeScope, opts: { sourceName?: string } = {}): boolean {
    if (this.running) return false;
    void this.runToCompletion(scope, opts);
    return true;
  }

  /**
   * Clears just the given source's *results* job names (per its adapter's resultsJobNames())
   * from its persisted completedArchiveJobs, then re-runs an archive-scope scrape for that
   * source — the existing skip-already-completed-job logic in each adapter's scrape() then
   * naturally re-runs only those jobs, leaving already-complete advertisement/listing jobs
   * alone. Returns false (same convention as start()) when a scrape is already running, the
   * source name matches no registered adapter, or the adapter has no results jobs at all.
   *
   * `this.running` is set synchronously as a reservation flag BEFORE the first `await`, then
   * released in a `finally` before calling `start()` (which re-acquires it properly). This
   * closes the race that would otherwise exist now that repo.getMeta()/setMeta() are real
   * async Mongo calls: without the synchronous reservation, two concurrent refreshResults()
   * calls (or a refreshResults() racing a start()) could both observe `this.running === false`
   * and both proceed past the guard before either one's Mongo round-trip resolves.
   */
  async refreshResults(sourceName: string): Promise<boolean> {
    if (this.running) return false;
    const adapter = this.adapters.find((a) => a.name === sourceName);
    if (!adapter) return false;
    const results = new Set(adapter.resultsJobNames?.() ?? []);
    if (results.size === 0) return false;
    this.running = true;
    try {
      const meta = await this.repo.getMeta(sourceName);
      const remaining = meta.completedArchiveJobs.filter((j) => !results.has(j));
      await this.repo.setMeta(sourceName, { completedArchiveJobs: remaining });
    } finally {
      this.running = false;
    }
    return this.start('archive', { sourceName });
  }

  async runToCompletion(scope: ScrapeScope, opts: { sourceName?: string } = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelRequested = false;
    this.current = { state: 'running' };
    const now = this.opts.now ?? (() => new Date().toISOString());
    const adapters = opts.sourceName ? this.adapters.filter((a) => a.name === opts.sourceName) : this.adapters;
    let activeSource: string | undefined;

    try {
      for (const adapter of adapters) {
        if (this.cancelRequested) break;
        activeSource = adapter.name;
        this.current = { state: 'running', source: activeSource };
        const completedArchiveJobs = new Set((await this.repo.getMeta(adapter.name)).completedArchiveJobs);
        await adapter.scrape(
          scope,
          {
            onProgress: (p) => {
              this.current = { state: 'running', ...p };
            },
            onBatch: async (patches) => {
              await this.repo.mergeMany(patches);
            },
            onJobDone: async (jobName) => {
              completedArchiveJobs.add(jobName);
              await this.repo.setMeta(adapter.name, { completedArchiveJobs: [...completedArchiveJobs] });
            },
          },
          { skipJobNames: completedArchiveJobs, isCancelled: () => this.cancelRequested },
        );
        if (this.cancelRequested) break; // run didn't finish — don't stamp meta for this adapter
        const stamp: Parameters<TenderRepository['setMeta']>[1] = {
          lastScrapedAt: now(),
          total: await this.repo.getSourceCount(adapter.name),
        };
        if (scope === 'all' || scope === 'archive') stamp.lastArchiveBackfillAt = now();
        await this.repo.setMeta(adapter.name, stamp);
      }
      if (!this.cancelRequested) {
        await this.repo.reconcileStaleOpen(new Date(now()));
      }
      this.current = this.cancelRequested ? { state: 'cancelled', source: activeSource } : { state: 'done' };
    } catch (err) {
      this.current = { state: 'failed', source: activeSource, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}
```

- [ ] **Step 4: Run the full backend test suite to verify Tasks 7 and 8 together pass**

Run: `npm test -w backend`
Expected: PASS — every test file green, including `app.test.ts` (now that `listSources`/`refreshResults` are async) and `manager.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrape/manager.ts backend/test/manager.test.ts
git commit -m "feat: propagate async repository calls through ScrapeManager, drop flush batching, close refreshResults race"
```

---

### Task 9: Rewrite `index.ts` to connect Mongo instead of loading JSON

**Files:**
- Modify: `backend/src/index.ts`
- Modify: `backend/Dockerfile`

**Interfaces:**
- Consumes: `TenderRepository` (Task 2), `createDailyRunStateStore` (Task 4), `createApp` (Task 7), `ScrapeManager` (Task 8), the `mongodb` driver (Task 1).
- Produces: nothing new for other tasks — this is the process entrypoint, excluded from the coverage gate (`backend/vitest.config.ts`'s `exclude: ['src/index.ts']`), so it has no dedicated unit test. Verified instead by Task 11's end-to-end docker-compose smoke check.

- [ ] **Step 1: Replace `backend/src/index.ts` in full**

```ts
import { MongoClient } from 'mongodb';
import { MyProcurementAdapter } from './scrapers/myprocurement/adapter.js';
import { SpanAdapter } from './scrapers/span/adapter.js';
import { KwspAdapter } from './scrapers/kwsp/adapter.js';
import { LlmAdapter } from './scrapers/llm/adapter.js';
import { createSpanFetchImpl } from './scrapers/span/spanFetchImpl.js';
import { createKwspBrowserFetchImpl } from './scrapers/kwsp/kwspBrowserFetchImpl.js';
import { createPoliteFetcher } from './http/politeFetch.js';
import { TenderRepository } from './storage/repository.js';
import type { SourceMetaDoc } from './storage/repository.js';
import type { TenderDoc } from './storage/tenderDoc.js';
import { ScrapeManager } from './scrape/manager.js';
import { createApp } from './api/app.js';
import { decideStartupPolicy } from './startupPolicy.js';
import { DailyScheduler } from './scheduler/DailyScheduler.js';
import { createDailyRunStateStore } from './scheduler/dailyRunState.js';
import type { SchedulerStateDoc } from './scheduler/dailyRunState.js';

const PORT = Number(process.env.PORT) || 3001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/tms';

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();
  const tendersCollection = db.collection<TenderDoc>('tenders');
  const sourceMetaCollection = db.collection<SourceMetaDoc>('sourceMeta');
  const schedulerStateCollection = db.collection<SchedulerStateDoc>('schedulerState');

  // Idempotent: createIndex on an already-existing equivalent index is a no-op, so this is
  // safe to run on every startup rather than only once. Supports the filters/sort in
  // query/tenders.ts (buildMatchStage + the $sort stage in queryTenders) and buildFacets'
  // distinct() calls.
  await Promise.all([
    tendersCollection.createIndex({ status: 1 }),
    tendersCollection.createIndex({ ministry: 1 }),
    tendersCollection.createIndex({ agency: 1 }),
    tendersCollection.createIndex({ category: 1 }),
    tendersCollection.createIndex({ closingDate: 1 }),
    tendersCollection.createIndex({ advertisedDate: 1 }),
    tendersCollection.createIndex({ 'sources.source': 1 }),
    tendersCollection.createIndex({ title: 'text', referenceNo: 'text' }),
  ]);

  const repo = new TenderRepository(tendersCollection, sourceMetaCollection);

  // Self-heals tenders left stuck as "open" past their deadline (see
  // docs/superpowers/specs/2026-07-10-stale-open-status-reconciliation-design.md) — fixes
  // whatever accumulated since this last ran; the daily scheduler below (see end of main())
  // keeps catching up even if nobody restarts the server or triggers a rescrape.
  const startupStaleCount = await repo.reconcileStaleOpen();
  if (startupStaleCount > 0) {
    console.log(`[startup] reconciled ${startupStaleCount} stale open tender(s)`);
  }

  const adapters = [
    new MyProcurementAdapter(createPoliteFetcher()),
    new SpanAdapter(createPoliteFetcher({ responseType: 'text', fetchImpl: createSpanFetchImpl() })),
    new KwspAdapter(createKwspBrowserFetchImpl()),
    new LlmAdapter(createPoliteFetcher({ responseType: 'text' })),
  ];
  const manager = new ScrapeManager(adapters, repo);

  // Startup scrape policy, decided PER ADAPTER (see startupPolicy.ts and
  // docs/superpowers/specs/2026-07-10-scrape-settings-page-design.md): a brand-new adapter
  // always gets its own full scrape at startup, regardless of whether other adapters already
  // have data.
  const mergedIsEmpty = (await repo.getAll()).length === 0;
  const plan: Array<{ name: string; scope: 'all' | 'archive' }> = [];
  for (const adapter of adapters) {
    const hasSource = await repo.hasSource(adapter.name);
    const { completedArchiveJobs } = await repo.getMeta(adapter.name);
    const { needsFull, needsBackfill, emptyStoreMismatch } = decideStartupPolicy({
      hasSource,
      mergedIsEmpty,
      archiveJobNames: adapter.archiveJobNames(),
      completedArchiveJobs,
    });
    if (emptyStoreMismatch) {
      console.warn(
        `[startup] ${adapter.name}: merged tender store is empty but this source reports prior completion — forcing full rescrape`,
      );
    }
    if (needsFull) plan.push({ name: adapter.name, scope: 'all' });
    else if (needsBackfill) plan.push({ name: adapter.name, scope: 'archive' });
  }
  if (plan.length > 0) {
    void (async () => {
      for (const { name, scope } of plan) {
        console.log(`[startup] ${name}: running ${scope} scrape`);
        await manager.runToCompletion(scope, { sourceName: name });
      }
    })();
  }

  const dailyRunState = createDailyRunStateStore(schedulerStateCollection);
  const dailyScheduler = new DailyScheduler({
    run: async () => {
      const staleCount = await repo.reconcileStaleOpen();
      if (staleCount > 0) console.log(`[daily] reconciled ${staleCount} stale open tender(s)`);
      await manager.waitUntilIdle();
      if (!manager.start('open', { sourceName: 'myprocurement' })) {
        console.log("[daily] scrape already in progress after waiting — skipping today's auto-scrape");
      }
    },
    loadLastRunDate: () => dailyRunState.load(),
    saveLastRunDate: (date) => dailyRunState.save(date),
  });
  try {
    await dailyScheduler.start();
  } catch (err) {
    console.error('[daily] scheduler failed to start; continuing without it:', err);
  }

  createApp({ repo, tendersCollection, manager }).listen(PORT, () => {
    console.log(`backend listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Update `backend/Dockerfile` — remove the on-disk data directory env var**

Change:
```dockerfile
ENV DATA_DIR=/app/data
```
to:
```dockerfile
ENV MONGO_URI=mongodb://mongo:27017/tms
```

(This is a default for the image; `docker-compose.yml`/`docker-compose.prod.yml` in Task 10 override it with the correct value for each environment.)

- [ ] **Step 3: Run the full backend test suite**

Run: `npm test -w backend`
Expected: PASS — `index.ts` is excluded from coverage/test, but this confirms nothing else regressed from the `Dockerfile`/`index.ts` edit (no test imports either file).

- [ ] **Step 4: Type-check the whole backend**

Run: `npx tsc --noEmit -p backend`
Expected: no errors — confirms `index.ts`'s use of the real `mongodb` driver's `Collection<T>` satisfies the `QueryableCollection<T>` interface structurally (repository/query modules are typed against `QueryableCollection<T>`, and `db.collection<T>(...)` returns the real driver's `Collection<T>`, which has a superset of compatible methods).

If this step reports a mismatch (e.g. the real driver's `find()` return type isn't structurally assignable to `FindCursorLike<T>`), fix it by widening `QueryableCollection`'s `find`/`aggregate` return types to accept any object with a compatible `toArray()` method, not by casting at the call site — keep `index.ts` cast-free.

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.ts backend/Dockerfile
git commit -m "feat: connect index.ts to MongoDB instead of loading JSON from disk"
```

---

### Task 10: Docker Compose — dev mongo service and new prod compose file

**Files:**
- Modify: `docker-compose.yml`
- Create: `docker-compose.prod.yml`

**Interfaces:**
- Consumes: `MONGO_URI` env var read by `backend/src/index.ts` (Task 9).
- Produces: nothing consumed by later tasks — this is the final infrastructure piece.

- [ ] **Step 1: Replace `docker-compose.yml` in full**

```yaml
services:
  mongo:
    image: mongo:8
    restart: unless-stopped
    volumes:
      - mongo-data:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping')"]
      interval: 5s
      timeout: 5s
      retries: 20

  backend:
    build:
      context: .
      dockerfile: backend/Dockerfile
    ports:
      - "3001:3001"
    environment:
      - PORT=3001
      - MONGO_URI=mongodb://mongo:27017/tms
    depends_on:
      mongo:
        condition: service_healthy

  frontend:
    build:
      context: .
      dockerfile: frontend/Dockerfile
    ports:
      - "8080:80"
    depends_on:
      - backend

volumes:
  mongo-data:
```

- [ ] **Step 2: Write `docker-compose.prod.yml`**

```yaml
services:
  backend:
    container_name: tender-aggregator-backend
    build:
      context: .
      dockerfile: backend/Dockerfile
    restart: unless-stopped
    environment:
      - PORT=3001
      - MONGO_URI=mongodb://mongo:27017/tms?replicaSet=rs0
    networks:
      - shared-mongo

  frontend:
    container_name: tender-aggregator-frontend
    build:
      context: .
      dockerfile: frontend/Dockerfile
    restart: unless-stopped
    ports:
      - "8080:80"
    depends_on:
      - backend

networks:
  shared-mongo:
    name: shared-mongo
    external: true
```

- [ ] **Step 3: Verify the dev stack starts and the backend can reach Mongo**

Run: `docker compose up --build -d`
Expected: all three services (`mongo`, `backend`, `frontend`) report `Up`/`healthy`.

Run: `docker compose logs backend --tail 30`
Expected: log line `backend listening on :3001`, no `MongoServerSelectionError` or connection-refused errors.

Run: `curl -s http://localhost:3001/api/health`
Expected: `{"ok":true}`

- [ ] **Step 4: Tear down**

Run: `docker compose down -v`

(This removes the `mongo-data` volume too — fine here since it's freshly created throwaway dev data from Step 3's smoke check, not anything the user needs kept.)

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml docker-compose.prod.yml
git commit -m "feat: add dev mongo service and docker-compose.prod.yml for the shared-mongo deployment"
```

---

### Task 11: Full-suite verification

**Files:**
- None modified — verification only.

- [ ] **Step 1: Run the entire workspace test suite**

Run: `npm test`
Expected: PASS across `shared`, `backend`, `frontend` workspaces — this is also what husky's pre-commit hook runs, so a green result here means every prior task's commit would have passed the hook for real (Tasks 3's interim commit is the only one that was allowed to leave the suite red mid-flight, and it's long since fixed by Task 9).

- [ ] **Step 2: Confirm coverage thresholds still hold**

Run: `npm run test -w backend -- --coverage`
Expected: lines and branches both ≥80% (per `backend/vitest.config.ts`'s `thresholds`). `backend/src/index.ts` is excluded from the count; every other rewritten file (`repository.ts`, `dailyRunState.ts`, `query/tenders.ts`, `api/app.ts`, `scrape/manager.ts`, `storage/tenderDoc.ts`) is covered by Tasks 1–8's test rewrites.

If coverage falls short, identify the uncovered branch with `open backend/coverage/index.html` (or read `backend/coverage/coverage-summary.json`) and add the missing test case to the relevant task's test file — do not lower the threshold.

- [ ] **Step 3: Type-check the whole workspace**

Run: `npx tsc --noEmit -p backend && npx tsc --noEmit -p frontend && npx tsc --noEmit -p shared`
Expected: no errors in any workspace.

- [ ] **Step 4: Re-run the docker-compose smoke check from Task 10 one more time end-to-end**

Run: `docker compose up --build -d && sleep 3 && curl -s http://localhost:3001/api/health && docker compose down -v`
Expected: `{"ok":true}`, containers exit cleanly.

No commit for this task — it's a verification pass confirming the prior 10 tasks compose into a working whole.
