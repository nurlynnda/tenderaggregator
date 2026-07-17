import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { z } from 'zod';
import { computeDedupKey } from '@tms/shared';
import type { ScrapeManager } from '../scrape/manager.js';
import type { TenderRepository } from '../storage/repository.js';
import type { QueryableCollection, TenderDoc } from '../storage/tenderDoc.js';
import { buildFacets, queryTenders } from '../query/tenders.js';
import { buildDashboardStats } from '../query/dashboard.js';
import { createAdminRoutes } from '../auth/adminRoutes.js';
import { createLoginRoutes } from '../auth/loginRoutes.js';
import { createRegisterRoutes } from '../auth/registerRoutes.js';
import { requireAdmin, requireAuth } from '../auth/middleware.js';
import type { PendingRegistrationRepository } from '../auth/pendingRegistrationRepository.js';
import type { UserRepository } from '../auth/userRepository.js';
import type { SessionRepository } from '../auth/sessionRepository.js';
import type { EmailSender } from '../auth/emailSender.js';
import type { WebAuthnService } from '../auth/webauthnService.js';
import type { RateLimiter } from '../auth/rateLimiter.js';
import { ah } from './asyncHandler.js';

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
  pendingRegistrations: PendingRegistrationRepository;
  users: UserRepository;
  sessions: SessionRepository;
  email: EmailSender;
  webauthn: WebAuthnService;
  rateLimiter: RateLimiter;
  adminEmail: string;
  sessionTtlMs: number;
  cookieSecret: string;
}) {
  const app = express();
  // Single reverse-proxy hop in the shipped Docker topology (frontend nginx -> backend), so
  // req.ip should reflect the client via X-Forwarded-For rather than always being the proxy's
  // address — this matters for the register rate limiter, which keys on req.ip.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser(deps.cookieSecret));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.use('/api/auth/register', createRegisterRoutes({
    pendingRegistrations: deps.pendingRegistrations,
    users: deps.users,
    sessions: deps.sessions,
    email: deps.email,
    webauthn: deps.webauthn,
    rateLimiter: deps.rateLimiter,
    adminEmail: deps.adminEmail,
    sessionTtlMs: deps.sessionTtlMs,
  }));
  app.use('/api/auth', createLoginRoutes({
    users: deps.users, sessions: deps.sessions, webauthn: deps.webauthn, sessionTtlMs: deps.sessionTtlMs,
  }));
  app.use('/api/admin', createAdminRoutes({ users: deps.users, sessions: deps.sessions, sessionTtlMs: deps.sessionTtlMs }));

  const auth = requireAuth(deps.sessions, deps.users, deps.sessionTtlMs);

  app.get('/api/sources', auth, ah(async (_req, res) => {
    res.json(await deps.manager.listSources());
  }));

  app.get('/api/tenders/facets', auth, ah(async (_req, res) => {
    res.json(await buildFacets(deps.tendersCollection));
  }));

  app.get('/api/dashboard', auth, ah(async (_req, res) => {
    res.json(buildDashboardStats(await deps.repo.findAwarded()));
  }));

  app.get('/api/tenders/:refNo', auth, ah(async (req, res) => {
    const key = computeDedupKey(req.params.refNo, req.params.refNo);
    const tender = await deps.repo.findByDedupKey(key);
    if (!tender) return res.status(404).json({ error: 'tender not found' });
    res.json({ tender });
  }));

  app.get('/api/tenders', auth, ah(async (req, res) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.json(await queryTenders(deps.tendersCollection, parsed.data));
  }));

  app.post('/api/scrape', auth, requireAdmin(), ah(async (req, res) => {
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
  }));

  app.post('/api/scrape/cancel', auth, requireAdmin(), (_req, res) => {
    if (!deps.manager.cancel()) return res.status(409).json({ error: 'nothing running' });
    res.json({ cancelled: true });
  });

  app.get('/api/scrape/status', auth, (_req, res) => {
    res.json(deps.manager.status());
  });

  // Terminal error-handling middleware (4-arg signature is what makes Express treat this as an
  // error handler). Catches anything forwarded via next(err) — including rejections from
  // handlers wrapped in `ah` above and from requireAuth/requireAdmin — and returns a clean
  // 500 instead of leaving the connection hanging.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[unhandled request error]', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
