import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { setSessionCookie } from '../../src/auth/cookies.js';
import { requireAdmin, requireAuth } from '../../src/auth/middleware.js';
import { SessionRepository } from '../../src/auth/sessionRepository.js';
import { UserRepository } from '../../src/auth/userRepository.js';
import type { SessionDoc, UserDoc } from '../../src/auth/types.js';
import { FakeCollection } from '../support/fakeMongoCollection.js';

const credential = { id: 'cred-1', publicKey: 'pk', counter: 0 };

describe('requireAuth / requireAdmin', () => {
  let sessions: SessionRepository;
  let users: UserRepository;
  let app: ReturnType<typeof express>;

  beforeEach(() => {
    sessions = new SessionRepository(new FakeCollection<SessionDoc>());
    users = new UserRepository(new FakeCollection<UserDoc>());
    app = express();
    app.use(cookieParser('test-secret'));
  });

  it('401s when there is no session cookie', async () => {
    app.get('/protected', requireAuth(sessions, users, 1000), (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
  });

  it('401s when the session cookie references an unknown session', async () => {
    app.get('/set-bad-cookie', (_req, res) => {
      setSessionCookie(res, 'unknown-session', 1000);
      res.json({ ok: true });
    });
    app.get('/protected', requireAuth(sessions, users, 1000), (_req, res) => res.json({ ok: true }));
    const agent = request.agent(app);
    await agent.get('/set-bad-cookie');
    const res = await agent.get('/protected');
    expect(res.status).toBe(401);
  });

  it('401s when the session cookie references a session whose expiresAt is in the past', async () => {
    const user = await users.create({ name: 'Jane', email: 'jane@example.com', role: 'member', credential });
    // ttlMs of -1000 puts expiresAt one second in the past relative to "now".
    const session = await sessions.create(user._id, -1000);
    app.get('/set-cookie', (_req, res) => {
      setSessionCookie(res, session._id, 1000);
      res.json({ ok: true });
    });
    app.get('/protected', requireAuth(sessions, users, 1000), (_req, res) => res.json({ ok: true }));
    const agent = request.agent(app);
    await agent.get('/set-cookie');
    const res = await agent.get('/protected');
    expect(res.status).toBe(401);
  });

  it('attaches req.user and allows the request through for a valid session', async () => {
    const user = await users.create({ name: 'Jane', email: 'jane@example.com', role: 'member', credential });
    const session = await sessions.create(user._id, 60 * 1000);
    app.get('/set-cookie', (_req, res) => {
      setSessionCookie(res, session._id, 60 * 1000);
      res.json({ ok: true });
    });
    app.get('/protected', requireAuth(sessions, users, 60 * 1000), (req: express.Request & { user?: UserDoc }, res) =>
      res.json({ email: req.user?.email }));
    const agent = request.agent(app);
    await agent.get('/set-cookie');
    const res = await agent.get('/protected');
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('jane@example.com');
  });

  it('requireAdmin lets an admin through and 403s a member', async () => {
    // Long TTL — this is a real (unmocked) clock, and requireAuth now enforces expiry, so a
    // short TTL like the old 1000ms would make this test flaky under slow test-runner load.
    const ttlMs = 60 * 1000;
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const member = await users.create({ name: 'Member', email: 'member@example.com', role: 'member', credential });
    const adminSession = await sessions.create(admin._id, ttlMs);
    const memberSession = await sessions.create(member._id, ttlMs);

    app.get('/set-cookie/:id', (req, res) => {
      setSessionCookie(res, req.params.id, ttlMs);
      res.json({ ok: true });
    });
    app.get('/admin-only', requireAuth(sessions, users, ttlMs), requireAdmin(), (_req, res) => res.json({ ok: true }));

    const adminAgent = request.agent(app);
    await adminAgent.get(`/set-cookie/${adminSession._id}`);
    expect((await adminAgent.get('/admin-only')).status).toBe(200);

    const memberAgent = request.agent(app);
    await memberAgent.get(`/set-cookie/${memberSession._id}`);
    expect((await memberAgent.get('/admin-only')).status).toBe(403);
  });
});
