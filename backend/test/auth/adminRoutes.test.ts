import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAdminRoutes } from '../../src/auth/adminRoutes.js';
import { setSessionCookie } from '../../src/auth/cookies.js';
import { SessionRepository } from '../../src/auth/sessionRepository.js';
import { UserRepository } from '../../src/auth/userRepository.js';
import type { SessionDoc, UserDoc } from '../../src/auth/types.js';
import { FakeCollection } from '../support/fakeMongoCollection.js';

const credential = { id: 'cred-1', publicKey: 'pk', counter: 0 };

describe('admin routes', () => {
  let users: UserRepository;
  let sessions: SessionRepository;
  let app: express.Express;

  beforeEach(() => {
    users = new UserRepository(new FakeCollection<UserDoc>());
    sessions = new SessionRepository(new FakeCollection<SessionDoc>());
    app = express();
    app.use(express.json());
    app.use(cookieParser('test-secret'));
    app.use('/api/admin', createAdminRoutes({ users, sessions, sessionTtlMs: 1000 * 60 * 60 }));
    app.get('/set-cookie/:id', (req, res) => {
      setSessionCookie(res, req.params.id, 1000 * 60 * 60);
      res.json({ ok: true });
    });
  });

  async function agentAs(userId: string) {
    const session = await sessions.create(userId, 1000 * 60 * 60);
    const agent = request.agent(app);
    await agent.get(`/set-cookie/${session._id}`);
    return agent;
  }

  it('GET /users 403s for a member and lists users for an admin', async () => {
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const member = await users.create({ name: 'Member', email: 'member@example.com', role: 'member', credential });

    const memberAgent = await agentAs(member._id);
    expect((await memberAgent.get('/api/admin/users')).status).toBe(403);

    const adminAgent = await agentAs(admin._id);
    const res = await adminAgent.get('/api/admin/users');
    expect(res.status).toBe(200);
    expect(res.body.users.map((u: { email: string }) => u.email).sort()).toEqual(['admin@example.com', 'member@example.com']);
  });

  it('PATCH /users/:id/role promotes a member to admin', async () => {
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const member = await users.create({ name: 'Member', email: 'member@example.com', role: 'member', credential });
    const adminAgent = await agentAs(admin._id);

    const res = await adminAgent.patch(`/api/admin/users/${member._id}/role`).send({ role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
  });

  it('PATCH /users/:id/role refuses to demote the last remaining admin', async () => {
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const adminAgent = await agentAs(admin._id);

    const res = await adminAgent.patch(`/api/admin/users/${admin._id}/role`).send({ role: 'member' });
    expect(res.status).toBe(409);
    expect((await users.findById(admin._id))?.role).toBe('admin');
  });

  it('PATCH /users/:id/role allows demoting an admin when another admin remains', async () => {
    const admin1 = await users.create({ name: 'Admin1', email: 'admin1@example.com', role: 'admin', credential });
    const admin2 = await users.create({ name: 'Admin2', email: 'admin2@example.com', role: 'admin', credential });
    const adminAgent = await agentAs(admin1._id);

    const res = await adminAgent.patch(`/api/admin/users/${admin2._id}/role`).send({ role: 'member' });
    expect(res.status).toBe(200);
  });

  it('PATCH /users/:id/role 404s for an unknown user and 400s for an invalid role', async () => {
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const adminAgent = await agentAs(admin._id);
    expect((await adminAgent.patch('/api/admin/users/nope/role').send({ role: 'member' })).status).toBe(404);
    expect((await adminAgent.patch(`/api/admin/users/${admin._id}/role`).send({ role: 'superadmin' })).status).toBe(400);
  });
});
