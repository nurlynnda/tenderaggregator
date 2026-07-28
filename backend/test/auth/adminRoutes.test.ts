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

  it('DELETE /users/:id removes a member and their sessions', async () => {
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const member = await users.create({ name: 'Member', email: 'member@example.com', role: 'member', credential });
    const memberSession = await sessions.create(member._id, 1000 * 60 * 60);
    const adminAgent = await agentAs(admin._id);

    const res = await adminAgent.delete(`/api/admin/users/${member._id}`);
    expect(res.status).toBe(200);
    expect(await users.findById(member._id)).toBeNull();
    expect(await sessions.findById(memberSession._id)).toBeNull();
  });

  it('DELETE /users/:id 404s for an unknown user', async () => {
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const adminAgent = await agentAs(admin._id);
    expect((await adminAgent.delete('/api/admin/users/nope')).status).toBe(404);
  });

  it('DELETE /users/:id refuses to remove the last remaining admin, even if it is your own account', async () => {
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const adminAgent = await agentAs(admin._id);

    const res = await adminAgent.delete(`/api/admin/users/${admin._id}`);
    expect(res.status).toBe(409);
    expect(await users.findById(admin._id)).not.toBeNull();
  });

  it('DELETE /users/:id refuses to remove your own account when another admin remains', async () => {
    const admin1 = await users.create({ name: 'Admin1', email: 'admin1@example.com', role: 'admin', credential });
    await users.create({ name: 'Admin2', email: 'admin2@example.com', role: 'admin', credential });
    const admin1Agent = await agentAs(admin1._id);

    const res = await admin1Agent.delete(`/api/admin/users/${admin1._id}`);
    expect(res.status).toBe(400);
    expect(await users.findById(admin1._id)).not.toBeNull();
  });

  it('DELETE /users/:id allows removing another admin when a third admin remains', async () => {
    const admin1 = await users.create({ name: 'Admin1', email: 'admin1@example.com', role: 'admin', credential });
    const admin2 = await users.create({ name: 'Admin2', email: 'admin2@example.com', role: 'admin', credential });
    await users.create({ name: 'Admin3', email: 'admin3@example.com', role: 'admin', credential });
    const admin1Agent = await agentAs(admin1._id);

    const res = await admin1Agent.delete(`/api/admin/users/${admin2._id}`);
    expect(res.status).toBe(200);
    expect(await users.findById(admin2._id)).toBeNull();
  });
});
