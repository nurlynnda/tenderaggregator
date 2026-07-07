import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tender } from '@tms/shared';

export interface SourceMeta {
  lastScrapedAt: string | null;
  lastArchiveBackfillAt: string | null;
  total: number;
}

const DEFAULT_META: SourceMeta = { lastScrapedAt: null, lastArchiveBackfillAt: null, total: 0 };

export class TenderRepository {
  // source -> (id -> Tender): Map keeps upserts O(1) even at archive scale
  private readonly bySource = new Map<string, Map<string, Tender>>();
  private readonly metaBySource = new Map<string, SourceMeta>();
  private readonly loadedSources = new Set<string>();

  constructor(private readonly dataDir: string) {}

  async load(): Promise<void> {
    let sources: string[] = [];
    try {
      sources = (await readdir(this.dataDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return; // data dir doesn't exist yet
    }
    for (const source of sources) {
      try {
        const tenders = JSON.parse(await readFile(join(this.dataDir, source, 'tenders.json'), 'utf8')) as Tender[];
        this.bySource.set(source, new Map(tenders.map((t) => [t.id, t])));
        this.loadedSources.add(source);
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
        /* no tenders.json for this source */
      }
      try {
        const meta = JSON.parse(await readFile(join(this.dataDir, source, 'meta.json'), 'utf8')) as SourceMeta;
        this.metaBySource.set(source, { ...DEFAULT_META, ...meta });
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
        /* no meta.json */
      }
    }
  }

  getAll(): Tender[] {
    return [...this.bySource.values()].flatMap((m) => [...m.values()]);
  }

  hasSource(source: string): boolean {
    return this.loadedSources.has(source);
  }

  upsertMany(source: string, tenders: Tender[]): void {
    let map = this.bySource.get(source);
    if (!map) {
      map = new Map();
      this.bySource.set(source, map);
    }
    for (const t of tenders) map.set(t.id, t);
  }

  async flush(source: string): Promise<void> {
    const map = this.bySource.get(source) ?? new Map<string, Tender>();
    const dir = join(this.dataDir, source);
    await mkdir(dir, { recursive: true });
    await atomicWrite(join(dir, 'tenders.json'), JSON.stringify([...map.values()]));
    this.loadedSources.add(source);
    await this.setMeta(source, { total: map.size });
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
