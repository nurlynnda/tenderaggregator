# MongoDB Storage Migration — Design

**Date:** 2026-07-16
**Status:** Approved by user

## Problem

Tender data is currently stored as JSON files on disk (`backend/data/tenders.json`,
`backend/data/field-provenance.json`, `backend/data/<source>/meta.json`,
`backend/data/daily-schedule.json`), loaded entirely into in-memory `Map`s at startup by
`TenderRepository`, and flushed back to disk after every scrape/merge. This works today but:

- every read (`getAll()`) returns the entire dataset, so all filtering/sorting/faceting for
  the API happens in plain JS over the full array — there's no way to query a subset;
  - the flush mechanism (atomic temp-file-then-rename, serialized behind a promise chain)
    exists purely to work around JSON files not supporting partial/concurrent writes;
- deploying to a new server means shipping and persisting a `backend/data/` volume instead
  of pointing at infrastructure the user already runs (a mongo stack already deployed on
  their production server, external to this repo).

This migration replaces the JSON-file storage layer with MongoDB, and adds a
`docker-compose.prod.yml` that connects to the user's existing mongo deployment.

## Existing production mongo stack (context, not part of this repo)

The user already runs a mongo stack on their production server:

```yaml
services:
  mongo:
    image: mongo:8
    hostname: mongo
    restart: unless-stopped
    command: ["--replSet", "rs0", "--bind_ip_all"]
    volumes:
      - mongo-data:/data/db
    healthcheck:
      test: ["CMD-SHELL", "mongosh --quiet --eval 'try { rs.status().ok } catch (e) { rs.initiate({_id: \"rs0\", members: [{_id: 0, host: \"mongo:27017\"}]}).ok }'"]
      interval: 5s
      timeout: 30s
      retries: 30
    networks:
      - shared-mongo
networks:
  shared-mongo:
    name: shared-mongo
    driver: bridge
volumes:
  mongo-data:
```

This repo's `docker-compose.prod.yml` joins `shared-mongo` as an **external** network and
connects to `mongo:27017` with `?replicaSet=rs0` — it does not define or manage the mongo
container itself.

## Decisions made during brainstorming

- **No data migration script.** Existing `backend/data/` JSON files are not carried over.
  Mongo starts empty; the existing per-adapter startup scrape policy in `index.ts`
  (`decideStartupPolicy` — "empty store → full scrape") naturally repopulates it.
- **Direct-to-Mongo reads, no in-memory cache.** Every repository read method queries Mongo
  directly. Simpler, one source of truth, no cache-invalidation risk. Read latency is not a
  concern for this app's traffic pattern (dashboard/search page loads, not a hot loop).
- **Field provenance embedded in the tender document** (`_provenance` field), not a separate
  collection — it's always read/written together with the tender it describes.
- **Merge logic stays read-modify-write in JS**, ported near-verbatim from today's
  `mergeOne`, rather than rewritten as atomic Mongo update operators. There's a single
  backend instance, so there's no concurrent-writer race to protect against, and this keeps
  the already-well-tested merge logic (null-clobber guard, per-field staleness check,
  per-source upsert) unchanged in shape.
- **Repository tests use a hand-written fake Mongo collection** (in-memory `Map`-backed,
  implementing only the driver methods the repository actually calls), not
  `mongodb-memory-server`. Matches the existing "injected fake" pattern already used for
  scrapers (e.g. `createPoliteFetcher`), and keeps tests fast with no real Mongo process.
- **Dev Mongo runs as plain standalone `mongo:8`**, not a replica set — nothing in the
  chosen design (no transactions, no change streams) requires one. Production's replica set
  is a property of the user's existing deployment, not something this repo needs to mirror.
- **Query/facet logic partially pushed into Mongo, hybrid with dashboard stats kept in JS:**
  - `queryTenders` (search/filter/sort/pagination) and `buildFacets` (distinct values) are
    rewritten to build Mongo filter/aggregation documents — they translate cleanly and this
    is exactly what a database is for.
  - `buildDashboardStats` keeps its contractor-name normalization/alias logic
    (`normalizeContractorName`, `CONTRACTOR_NAME_ALIASES`) as plain JS, operating on a
    Mongo-filtered subset (awarded tenders only). That logic doesn't translate cleanly into
    aggregation-pipeline syntax ($switch/$regexMatch) without becoming much harder to read,
    for no real benefit — it stays exactly as well-tested JS, just fed by a narrower query.
- **Backend container in `docker-compose.prod.yml` gets an explicit unique
  `container_name: tender-aggregator-backend`** so it doesn't collide with containers from
  other compose stacks also attached to the shared `shared-mongo` network.

## Data model

Database: `tms`, a single database for this app (matches the `tms-v2` project name).

### `tenders` collection
One document per tender. `_id` = `dedupKey` (replaces the array-in-one-file model). Same
shape as today's `Tender` type (`shared/src/tender.ts`), plus one additional field:

```ts
{
  _id: string,          // = dedupKey
  referenceNo: string,
  title: string,
  status: 'open' | 'closed',
  procurementType: 'quotation' | 'tender' | 'requisition',
  ministry: string | null,
  agency: string | null,
  category: string | null,
  fieldCodes: string[],
  advertisedDate: string | null,
  closingDate: string | null,
  indicativePrice: number | null,
  currency: 'MYR',
  events: TenderEvent[],
  winners: Winner[] | null,
  raw: Record<string, unknown>,
  scrapedAt: string,
  sources: TenderSource[],
  _provenance: Record<string, string>,  // fieldName -> ISO timestamp of last writing patch
}
```

Indexes:
- `status`, `ministry`, `agency`, `category`, `closingDate`, `advertisedDate` — single-field
  indexes, one per common filter in `TenderQuery`.
- `sources.source` — supports the `q.source` filter and `getSourceCount()`.

`q.search` matches via case-insensitive `$regex` substring matching on `title`/`referenceNo`
(needed to support partial-word matches like `search=stride` matching `KP/STRIDE/26`), so it
is not backed by a Mongo text index — `$regex` scans can't use one anyway.

### `sourceMeta` collection
One document per scraper source. `_id` = source name (`myprocurement`, `span`, `kwsp`,
`llm`). Same shape as today's `SourceMeta`:

```ts
{
  _id: string,  // source name
  lastScrapedAt: string | null,
  lastArchiveBackfillAt: string | null,
  total: number,
  completedArchiveJobs: string[],
}
```

### `schedulerState` collection
Single document, `_id: 'daily'`:

```ts
{ _id: 'daily', lastRunDate: string | null }
```

## Component changes

### `backend/src/storage/repository.ts` — rewritten
- Constructor takes a Mongo `Db` handle (or the three collections) instead of a `dataDir`
  string.
- `load()` is deleted — there's no upfront load step; every method queries Mongo when called.
- `getAll()`, `findByDedupKey()`, `hasSource()`, `getSourceCount()`, `getMeta()` all become
  `async`, backed by `findOne`/`find`/`countDocuments` calls.
- `mergeOne`/`mergeMany` keep today's JS merge logic (null-clobber guard, staleness check,
  per-source upsert), now wrapped as `await findOne` → compute merged doc → `await
  replaceOne(..., { upsert: true })`.
- `reconcileStaleOpen` becomes a Mongo `updateMany` with a date-based filter (closing-date
  cutoff or one-month-past-advertised fallback), replacing the current JS loop over the
  in-memory map. Returns the modified count.
- `flush()` / `doFlush()` / the flush promise-chain serialization are deleted — Mongo writes
  are already durable per-document; there's nothing to batch-flush.
- `setMeta()` becomes an `upsert` on `sourceMeta`.
- New methods: `query(q: TenderQuery): Promise<TenderPage>` and
  `facets(): Promise<Facets>`, replacing the "caller does `getAll()` then filters in JS"
  pattern — these build and run Mongo filter/aggregation documents internally (see Query
  layer below).

### `backend/src/scheduler/dailyRunState.ts` — rewritten
Same `{ load, save }` interface, backed by a `findOne`/`upsert` against `schedulerState`
instead of `daily-schedule.json`. Takes a Mongo collection instead of `dataDir`.

### `backend/src/query/tenders.ts` — rewritten
- `queryTenders` and `buildFacets` change from "take a `Tender[]`, filter/sort/aggregate in
  JS" to "take a Mongo collection + `TenderQuery`, build and execute a Mongo
  filter/aggregation." Their exported type signatures (`TenderQuery`, `TenderPage`,
  `Facets`) are unchanged — only how the data is produced changes.
- Pagination (`page`/`pageSize`), sorting (`sortBy`/`sortOrder` with nulls-last), and every
  existing filter (`search`, `ministry`, `agency`, `category`, `source`, `closingFrom/To`,
  `status`, `procurementType`, `fieldCode` prefix match, `hasWinners`, `contractor`
  substring) are re-expressed as Mongo query operators (`$regex`/text search, `$gte`/`$lte`,
  `$elemMatch`, etc.) with equivalent semantics.

### `backend/src/query/dashboard.ts` — mostly unchanged
- `buildDashboardStats(tenders: Tender[])` keeps its exact current signature and logic
  (`isAwarded`, `normalizeContractorName`, `CONTRACTOR_NAME_ALIASES`,
  `canonicalizeContractorName`, all the map-building loops).
- Its caller (`app.ts`) changes from `buildDashboardStats(deps.repo.getAll())` to
  `buildDashboardStats(await deps.repo.findAwarded())` — a new narrow repository method
  that runs a simple Mongo filter (`status: 'closed', winners: { $ne: null, $not: { $size:
  0 } }`) instead of fetching everything.

### `backend/src/api/app.ts`
Every route handler that calls `deps.repo.getAll()`, `deps.repo.getMeta()`, etc. becomes
`async` and `await`s the now-async repository/query calls. No route behavior changes.

### `backend/src/scrape/manager.ts`
Already mostly `await`s repository calls (`flush()`, `setMeta()`); the remaining sync calls
(`getMeta()`, `getSourceCount()`, `reconcileStaleOpen()`) get `await` added. No logic changes.

### `backend/src/index.ts`
- `resolveDataDir.ts` is deleted (no more on-disk data directory to resolve).
- Startup connects a `MongoClient` once (new step, parallel to where `repo.load()` used to
  be called), reads `MONGO_URI` from env.
- `repo.load()` call is removed; `decideStartupPolicy` inputs (`hasSource`, `getMeta`) become
  `await`ed.

## Error handling & connection lifecycle

- Single `MongoClient`, connected once at startup, reused for the process lifetime. If the
  initial connection fails, the process logs the error and exits — same failure posture as
  today's "data directory unwritable" case.
- Per-operation Mongo errors (network blip, timeout) propagate up through the now-async
  repository/query methods to Express route handlers, which catch and return `500` — new
  behavior, since today's synchronous in-memory calls can't throw for infra reasons.
- `mergeOne`'s null-clobber guard and staleness check are unchanged pure-JS logic, computed
  between the `findOne` and `replaceOne` calls.

## Testing strategy

- **`backend/test/repository.test.ts`**: inject a hand-written fake Mongo collection — a
  small class backed by an in-memory `Map`, implementing only the driver methods
  `TenderRepository` calls (`findOne`, `replaceOne`, `updateMany`, `find().toArray()`,
  `countDocuments`, etc.). Exercises the real merge/query logic with no real Mongo process,
  network, or `mongodb-memory-server` dependency — same pattern as today's injected fetch
  fakes for scrapers.
- **`backend/test/manager.test.ts`, `backend/test/app.test.ts`**: continue receiving a fake
  repository object (already today's pattern) — unaffected by the Mongo swap itself, only by
  the repository's methods becoming `async` (call sites add `await`).
- **New tests for `queryTenders`/`buildFacets`**: assert the Mongo filter/aggregation
  documents built for each `TenderQuery` combination produce correct results when run
  against the fake collection — covering the translation logic end to end without touching
  real Mongo.
- Per `CLAUDE.md`, no test may hit a real database, mirroring the existing rule about never
  hitting the real MyProcurement site.

## Docker Compose changes

### `docker-compose.yml` (dev) — modified
- Add a `mongo` service: plain standalone `mongo:8` (no replica set), with a named volume
  for data persistence across restarts and a healthcheck.
- Remove the `./backend/data:/app/data` volume mount from `backend`.
- Add `MONGO_URI=mongodb://mongo:27017/tms` to `backend`'s environment.
- `backend` gets `depends_on: mongo: condition: service_healthy`.

### `docker-compose.prod.yml` (new)
- `backend` and `frontend` services only — no `mongo` service, since mongo is already
  running as a separate stack on the production server.
- `backend` gets `container_name: tender-aggregator-backend` to avoid name collisions with
  other stacks on the shared network; `frontend` gets `container_name:
  tender-aggregator-frontend` for consistency (it doesn't join `shared-mongo` itself, only
  `backend` does).
- `backend`'s `MONGO_URI=mongodb://mongo:27017/tms?replicaSet=rs0`, matching the existing
  production stack's `mongo` hostname and `rs0` replica set.
- Networks: `shared-mongo` declared as `external: true` (created by the separately-deployed
  mongo stack, not by this file).

## New dependency

- `backend/package.json`: add `mongodb` (the official driver, not `mongoose`) — the codebase
  already hand-rolls its schema validation via Zod in `shared/`, so a plain driver fits the
  existing style better than an ODM layering its own schema system on top.

## Out of scope

- Any change to the scrapers themselves (`backend/src/scrapers/**`) — they still emit
  `TenderPatch` objects; only what receives and stores those patches changes.
- Any change to the frontend — it talks to the same REST API surface, unaffected by the
  storage swap.
- Multi-instance / horizontal scaling considerations (e.g. atomic Mongo update operators
  instead of read-modify-write) — explicitly deferred since there's a single backend
  instance today.
