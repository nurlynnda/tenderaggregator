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
