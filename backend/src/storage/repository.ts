import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tender, TenderPatch } from '@tms/shared';

export interface SourceMeta {
  lastScrapedAt: string | null;
  lastArchiveBackfillAt: string | null;
  total: number;
  /** Closed/archive job names (see ScraperAdapter.archiveJobNames) that have fully paginated at least
   * once. Tracked per job kind — rather than a single completion flag — so that adding a new archive
   * job (e.g. a results scraper) is automatically detected as incomplete and gets backfilled, instead
   * of being silently skipped forever because an unrelated job already finished in the past. */
  completedArchiveJobs: string[];
}

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

type ProvenanceMap = Record<string, string>; // fieldName -> scrapedAt ISO of the patch that last wrote it

export class TenderRepository {
  private readonly merged = new Map<string, Tender>(); // dedupKey -> Tender
  private readonly provenance = new Map<string, ProvenanceMap>(); // dedupKey -> field provenance
  private readonly metaBySource = new Map<string, SourceMeta>();

  constructor(private readonly dataDir: string) {}

  async load(): Promise<void> {
    try {
      const tenders = JSON.parse(await readFile(join(this.dataDir, 'tenders.json'), 'utf8')) as Tender[];
      for (const t of tenders) this.merged.set(t.dedupKey, t);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    try {
      const prov = JSON.parse(
        await readFile(join(this.dataDir, 'field-provenance.json'), 'utf8'),
      ) as Record<string, ProvenanceMap>;
      for (const [key, value] of Object.entries(prov)) this.provenance.set(key, value);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }

    let sourceDirs: string[] = [];
    try {
      sourceDirs = (await readdir(this.dataDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return; // data dir doesn't exist yet
    }
    for (const source of sourceDirs) {
      try {
        const meta = JSON.parse(await readFile(join(this.dataDir, source, 'meta.json'), 'utf8')) as SourceMeta;
        this.metaBySource.set(source, { ...DEFAULT_META, ...meta });
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
    }
  }

  getAll(): Tender[] {
    return [...this.merged.values()];
  }

  findByDedupKey(dedupKey: string): Tender | null {
    return this.merged.get(dedupKey) ?? null;
  }

  hasSource(source: string): boolean {
    return this.metaBySource.has(source);
  }

  getSourceCount(source: string): number {
    let count = 0;
    for (const t of this.merged.values()) {
      if (t.sources.some((s) => s.source === source)) count += 1;
    }
    return count;
  }

  mergeMany(patches: TenderPatch[]): void {
    for (const patch of patches) this.mergeOne(patch);
  }

  // Derives status from dates already on the record: flips `open` -> `closed` once the
  // closing-date cutoff (or, lacking one, the one-month-past-advertised fallback) has
  // passed. Never touches field-provenance.json — this is a correction, not an observation.
  reconcileStaleOpen(now: Date = new Date()): number {
    let count = 0;
    for (const t of this.merged.values()) {
      if (t.status !== 'open') continue;

      if (t.closingDate) {
        if (now >= closingCutoff(t.closingDate)) {
          t.status = 'closed';
          count += 1;
        }
      } else if (t.advertisedDate) {
        if (now > addOneMonth(t.advertisedDate)) {
          t.status = 'closed';
          count += 1;
        }
      }
    }
    return count;
  }

  private mergeOne(patch: TenderPatch): void {
    const key = patch.dedupKey;
    const existing = this.merged.get(key);

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
      const prov: ProvenanceMap = {};
      for (const field of Object.keys(patch)) {
        if (field === 'dedupKey' || field === 'source') continue;
        prov[field] = patch.scrapedAt;
      }
      this.merged.set(key, seeded);
      this.provenance.set(key, prov);
      return;
    }

    const prov = this.provenance.get(key) ?? {};
    this.provenance.set(key, prov);
    const mutable = existing as unknown as Record<string, unknown>;

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

    const srcIdx = existing.sources.findIndex((s) => s.source === patch.source.source);
    if (srcIdx === -1) existing.sources.push(patch.source);
    else existing.sources[srcIdx] = patch.source;
  }

  private flushChain: Promise<void> = Promise.resolve();

  // Serializes every flush behind a promise chain: multiple independent callers (the
  // scrape manager and the recurring stale-status sweep both call this) must never have
  // their writes to tenders.json.tmp interleave. Each caller still gets a promise tied to
  // its own flush's outcome — a failed flush doesn't wedge the chain for later callers.
  flush(): Promise<void> {
    const next = this.flushChain.then(
      () => this.doFlush(),
      () => this.doFlush(),
    );
    this.flushChain = next.catch(() => {});
    return next;
  }

  private async doFlush(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    // Each write below is individually atomic (temp file + rename), but the pair is not
    // atomic together: a crash between them can leave field-provenance.json out of sync
    // with tenders.json. This is a known, accepted window — the null-clobber guard in
    // mergeOne() (NULLABLE_FIELDS) means a slightly stale/missing provenance entry can at
    // worst cause one extra overwrite on the next merge, never data loss or corruption.
    await atomicWrite(join(this.dataDir, 'tenders.json'), JSON.stringify([...this.merged.values()]));
    await atomicWrite(
      join(this.dataDir, 'field-provenance.json'),
      JSON.stringify(Object.fromEntries(this.provenance)),
    );
  }

  getMeta(source: string): SourceMeta {
    return this.metaBySource.get(source) ?? { ...DEFAULT_META };
  }

  async setMeta(source: string, patch: Partial<SourceMeta>): Promise<void> {
    const merged = { ...this.getMeta(source), ...patch };
    this.metaBySource.set(source, merged);
    const dir = join(this.dataDir, source);
    await mkdir(dir, { recursive: true });
    await atomicWrite(join(dir, 'meta.json'), JSON.stringify(merged, null, 2));
  }
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
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
