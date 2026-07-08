import express from 'express';
import { z } from 'zod';
import { computeDedupKey } from '@tms/shared';
import type { ScrapeManager } from '../scrape/manager.js';
import type { TenderRepository } from '../storage/repository.js';
import { buildFacets, queryTenders } from '../query/tenders.js';

const QuerySchema = z.object({
  search: z.string().optional(),
  ministry: z.string().optional(),
  agency: z.string().optional(),
  category: z.string().optional(),
  status: z.enum(['open', 'closed']).optional(),
  procurementType: z.enum(['quotation', 'tender', 'requisition']).optional(),
  fieldCode: z.string().optional(),
  hasWinners: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  sortBy: z.enum(['advertisedDate', 'closingDate', 'indicativePrice']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
});

export function createApp(deps: { repo: TenderRepository; manager: ScrapeManager }) {
  const app = express();

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/tenders/facets', (_req, res) => {
    res.json(buildFacets(deps.repo.getAll()));
  });

  app.get('/api/tenders/:refNo', (req, res) => {
    const key = computeDedupKey(req.params.refNo, req.params.refNo);
    const tender = deps.repo.findByDedupKey(key);
    if (!tender) return res.status(404).json({ error: 'tender not found' });
    res.json({ tender });
  });

  app.get('/api/tenders', (req, res) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.json(queryTenders(deps.repo.getAll(), parsed.data));
  });

  app.post('/api/scrape', (_req, res) => {
    if (!deps.manager.start('open')) {
      return res.status(409).json({ error: 'scrape already running' });
    }
    res.status(202).json({ started: true });
  });

  app.get('/api/scrape/status', (_req, res) => {
    res.json(deps.manager.status());
  });

  return app;
}
