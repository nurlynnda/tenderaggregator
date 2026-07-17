import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLoginRoutes } from '../../src/auth/loginRoutes.js';
import { SessionRepository } from '../../src/auth/sessionRepository.js';
import { UserRepository } from '../../src/auth/userRepository.js';
import { FakeWebAuthnService } from '../../src/auth/webauthnService.js';
import type { SessionDoc, UserDoc } from '../../src/auth/types.js';
import { FakeCollection } from '../support/fakeMongoCollection.js';

const credential = { id: 'cred-1', publicKey: 'pk', counter: 0 };

describe('login routes', () => {
  let users: UserRepository;
  let sessions: SessionRepository;
  let webauthn: FakeWebAuthnService;
  let app: express.Express;

  beforeEach(() => {
    users = new UserRepository(new FakeCollection<UserDoc>());
    sessions = new SessionRepository(new FakeCollection<SessionDoc>());
    webauthn = new FakeWebAuthnService();
    app = express();
    app.use(express.json());
    app.use(cookieParser('test-secret'));
    app.use('/api/auth', createLoginRoutes({ users, sessions, webauthn, sessionTtlMs: 1000 * 60 * 60 }));
  });

  it('login/options 404s for an unknown email', async () => {
    const res = await request(app).post('/api/auth/login/options').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(404);
  });

  it('full login round trip: options -> verify -> me -> logout -> me 401s', async () => {
    const user = await users.create({ name: 'Jane', email: 'jane@example.com', role: 'member', credential });
    const agent = request.agent(app);

    const options = await agent.post('/api/auth/login/options').send({ email: 'jane@example.com' });
    expect(options.status).toBe(200);
    expect(options.body.allowCredentials).toEqual([{ id: 'cred-1' }]);

    const verify = await agent.post('/api/auth/login/verify').send({ email: 'jane@example.com', response: {} });
    expect(verify.status).toBe(200);
    expect(verify.body.user).toEqual({ name: 'Jane', email: 'jane@example.com', role: 'member' });

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ name: 'Jane', email: 'jane@example.com', role: 'member' });

    await agent.post('/api/auth/logout');
    const afterLogout = await agent.get('/api/auth/me');
    expect(afterLogout.status).toBe(401);
    void user;
  });

  it('login/verify 401s when the WebAuthn assertion fails to verify', async () => {
    await users.create({ name: 'Jane', email: 'jane@example.com', role: 'member', credential });
    webauthn.nextAuthenticationResult = { verified: false };
    const agent = request.agent(app);
    await agent.post('/api/auth/login/options').send({ email: 'jane@example.com' });
    const res = await agent.post('/api/auth/login/verify').send({ email: 'jane@example.com', response: {} });
    expect(res.status).toBe(401);
  });

  it('login/verify 400s without a preceding login/options call', async () => {
    await users.create({ name: 'Jane', email: 'jane@example.com', role: 'member', credential });
    const res = await request(app).post('/api/auth/login/verify').send({ email: 'jane@example.com', response: {} });
    expect(res.status).toBe(400);
  });

  it('me 401s when there is no session', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});
