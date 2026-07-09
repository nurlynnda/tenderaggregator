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

  async flush(): Promise<void> {
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
