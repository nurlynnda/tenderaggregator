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
  const dotIndex = field.indexOf('.');
  if (dotIndex !== -1) {
    const head = field.slice(0, dotIndex);
    const rest = field.slice(dotIndex + 1);
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
    // Optimize for the common case of direct _id lookup
    if (Object.keys(filter).length === 1 && '_id' in filter) {
      return this.docs.get(filter._id as string) ?? null;
    }
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
