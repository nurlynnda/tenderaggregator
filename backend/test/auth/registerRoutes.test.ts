import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRegisterRoutes } from '../../src/auth/registerRoutes.js';
import { PendingRegistrationRepository } from '../../src/auth/pendingRegistrationRepository.js';
import { UserRepository } from '../../src/auth/userRepository.js';
import { SessionRepository } from '../../src/auth/sessionRepository.js';
import { FakeEmailSender } from '../../src/auth/emailSender.js';
import { FakeWebAuthnService } from '../../src/auth/webauthnService.js';
import { InMemoryRateLimiter } from '../../src/auth/rateLimiter.js';
import { hashOtp } from '../../src/auth/otp.js';
import type { PendingRegistrationDoc, SessionDoc, UserDoc } from '../../src/auth/types.js';
import { FakeCollection } from '../support/fakeMongoCollection.js';

describe('register routes', () => {
  let pendingRegistrations: PendingRegistrationRepository;
  let users: UserRepository;
  let sessions: SessionRepository;
  let email: FakeEmailSender;
  let webauthn: FakeWebAuthnService;
  let rateLimiter: InMemoryRateLimiter;
  let app: express.Express;

  beforeEach(() => {
    pendingRegistrations = new PendingRegistrationRepository(new FakeCollection<PendingRegistrationDoc>());
    users = new UserRepository(new FakeCollection<UserDoc>());
    sessions = new SessionRepository(new FakeCollection<SessionDoc>());
    email = new FakeEmailSender();
    webauthn = new FakeWebAuthnService();
    rateLimiter = new InMemoryRateLimiter(() => 0);
    app = express();
    app.use(express.json());
    app.use(cookieParser('test-secret'));
    app.use(
      '/api/auth/register',
      createRegisterRoutes({
        pendingRegistrations, users, email, webauthn, rateLimiter, sessions,
        adminEmail: 'admin@example.com', sessionTtlMs: 1000 * 60 * 60,
        now: () => new Date('2026-07-17T10:00:00.000Z'),
      }),
    );
  });

  it('POST /request emails the admin and sets a pending-reg cookie', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/register/request').send({ name: 'Jane', email: 'jane@example.com' });
    expect(res.status).toBe(202);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe('admin@example.com');
    expect(email.sent[0].text).toMatch(/\d{6}/);
    expect(email.sent[0].text).toContain('Jane');
    expect(email.sent[0].text).toContain('jane@example.com');
  });

  it('POST /request is throttled after 3 requests from the same IP', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register/request').send({ name: 'A', email: 'a@example.com' });
    await agent.post('/api/auth/register/request').send({ name: 'B', email: 'b@example.com' });
    await agent.post('/api/auth/register/request').send({ name: 'C', email: 'c@example.com' });
    const res = await agent.post('/api/auth/register/request').send({ name: 'D', email: 'd@example.com' });
    expect(res.status).toBe(429);
  });

  it('verify-otp rejects wrong codes, locks after 3 attempts, and accepts the right one', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register/request').send({ name: 'Jane', email: 'jane@example.com' });
    const otpText = email.sent[0].text;
    const otp = otpText.match(/\d{6}/)?.[0] as string;

    expect((await agent.post('/api/auth/register/verify-otp').send({ otp: '000001' })).status).toBe(400);
    expect((await agent.post('/api/auth/register/verify-otp').send({ otp: '000002' })).status).toBe(400);
    const locked = await agent.post('/api/auth/register/verify-otp').send({ otp: '000003' });
    expect(locked.status).toBe(410);

    // must restart after lockout — the old cookie no longer references a live pending registration
    const retry = await agent.post('/api/auth/register/verify-otp').send({ otp });
    expect(retry.status).toBe(400);
  });

  it('verify-otp succeeds with the correct code', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register/request').send({ name: 'Jane', email: 'jane@example.com' });
    const otp = email.sent[0].text.match(/\d{6}/)?.[0] as string;
    const res = await agent.post('/api/auth/register/verify-otp').send({ otp });
    expect(res.status).toBe(200);
  });

  it('passkey/options 400s before verification and succeeds after', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register/request').send({ name: 'Jane', email: 'jane@example.com' });
    expect((await agent.post('/api/auth/register/passkey/options')).status).toBe(400);

    const otp = email.sent[0].text.match(/\d{6}/)?.[0] as string;
    await agent.post('/api/auth/register/verify-otp').send({ otp });
    const res = await agent.post('/api/auth/register/passkey/options');
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe('fake-registration-challenge');
  });

  it('passkey/verify creates the user, admin role for ADMIN_EMAIL, and sets a session cookie', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register/request').send({ name: 'Admin Person', email: 'admin@example.com' });
    const otp = email.sent[0].text.match(/\d{6}/)?.[0] as string;
    await agent.post('/api/auth/register/verify-otp').send({ otp });
    await agent.post('/api/auth/register/passkey/options');

    const res = await agent.post('/api/auth/register/passkey/verify').send({ response: {} });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ name: 'Admin Person', email: 'admin@example.com', role: 'admin' });

    const created = await users.findByEmail('admin@example.com');
    expect(created?.role).toBe('admin');
  });

  it('passkey/verify gives a non-admin-email registrant the member role', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register/request').send({ name: 'Regular', email: 'regular@example.com' });
    const otp = email.sent[0].text.match(/\d{6}/)?.[0] as string;
    await agent.post('/api/auth/register/verify-otp').send({ otp });
    await agent.post('/api/auth/register/passkey/options');
    const res = await agent.post('/api/auth/register/passkey/verify').send({ response: {} });
    expect(res.body.user.role).toBe('member');
  });

  it('passkey/verify returns 409 when an account with that email already exists', async () => {
    const registerOnce = async () => {
      const agent = request.agent(app);
      await agent.post('/api/auth/register/request').send({ name: 'Jane', email: 'jane@example.com' });
      const otp = email.sent[email.sent.length - 1].text.match(/\d{6}/)?.[0] as string;
      await agent.post('/api/auth/register/verify-otp').send({ otp });
      await agent.post('/api/auth/register/passkey/options');
      return agent.post('/api/auth/register/passkey/verify').send({ response: {} });
    };

    const first = await registerOnce();
    expect(first.status).toBe(200);

    const second = await registerOnce();
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('an account with that email already exists');
  });

  it('passkey/verify 400s when the WebAuthn ceremony fails and creates no user', async () => {
    webauthn.nextRegistrationResult = { verified: false };
    const agent = request.agent(app);
    await agent.post('/api/auth/register/request').send({ name: 'Jane', email: 'jane@example.com' });
    const otp = email.sent[0].text.match(/\d{6}/)?.[0] as string;
    await agent.post('/api/auth/register/verify-otp').send({ otp });
    await agent.post('/api/auth/register/passkey/options');
    const res = await agent.post('/api/auth/register/passkey/verify').send({ response: {} });
    expect(res.status).toBe(400);
    expect(await users.findByEmail('jane@example.com')).toBeNull();
  });
});
