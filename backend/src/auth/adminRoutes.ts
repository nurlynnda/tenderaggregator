import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth } from './middleware.js';
import type { SessionRepository } from './sessionRepository.js';
import type { UserRepository } from './userRepository.js';

const RoleSchema = z.object({ role: z.enum(['admin', 'member']) });

export function createAdminRoutes(deps: { users: UserRepository; sessions: SessionRepository; sessionTtlMs: number }): Router {
  const router = Router();
  router.use(requireAuth(deps.sessions, deps.users, deps.sessionTtlMs), requireAdmin());

  router.get('/users', async (_req, res) => {
    const all = await deps.users.findAll();
    res.json({
      users: all.map((u) => ({ id: u._id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt })),
    });
  });

  router.patch('/users/:id/role', async (req, res) => {
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
  });

  return router;
}
