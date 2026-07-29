import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../api/asyncHandler.js';
import type { AuthedRequest } from './middleware.js';
import { requireAdmin, requireAuth } from './middleware.js';
import type { SessionRepository } from './sessionRepository.js';
import type { UserRepository } from './userRepository.js';

const RoleSchema = z.object({ role: z.enum(['admin', 'member']) });

export function createAdminRoutes(deps: { users: UserRepository; sessions: SessionRepository; sessionTtlMs: number }): Router {
  const router = Router();
  router.use(requireAuth(deps.sessions, deps.users, deps.sessionTtlMs), requireAdmin());

  router.get('/users', ah(async (_req, res) => {
    const all = await deps.users.findAll();
    res.json({
      users: all.map((u) => ({ id: u._id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt })),
    });
  }));

  router.patch('/users/:id/role', ah(async (req, res) => {
    const parsed = RoleSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const target = await deps.users.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'user not found' });

    if (target.role === 'admin' && parsed.data.role !== 'admin') {
      const adminCount = await deps.users.countByRole('admin');
      if (adminCount <= 1) return res.status(409).json({ error: 'cannot demote the last remaining admin' });
    }

    await deps.users.updateRole(target._id, parsed.data.role);
    res.json({ id: target._id, name: target.name, email: target.email, role: parsed.data.role, createdAt: target.createdAt });
  }));

  router.delete('/users/:id', ah(async (req, res) => {
    const target = await deps.users.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'user not found' });

    if (target.role === 'admin') {
      const adminCount = await deps.users.countByRole('admin');
      if (adminCount <= 1) return res.status(409).json({ error: 'cannot remove the last remaining admin' });
    }

    const requester = (req as AuthedRequest).user;
    if (target._id === requester?._id) return res.status(400).json({ error: 'cannot remove your own account' });

    await deps.sessions.deleteByUserId(target._id);
    await deps.users.delete(target._id);
    res.json({ ok: true });
  }));

  return router;
}
