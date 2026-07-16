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
