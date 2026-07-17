import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearLoginChallengeCookie,
  clearPendingRegCookie,
  clearSessionCookie,
  PENDING_REG_COOKIE,
  readLoginChallengeCookie,
  readPendingRegCookie,
  readSessionCookie,
  SESSION_COOKIE,
  setLoginChallengeCookie,
  setPendingRegCookie,
  setSessionCookie,
} from '../../src/auth/cookies.js';

function buildApp() {
  const app = express();
  app.use(cookieParser('test-secret'));
  app.get('/set-pending', (_req, res) => {
    setPendingRegCookie(res, 'pending-123');
    res.json({ ok: true });
  });
  app.get('/read-pending', (req, res) => res.json({ id: readPendingRegCookie(req) ?? null }));
  app.get('/clear-pending', (_req, res) => {
    clearPendingRegCookie(res);
    res.json({ ok: true });
  });
  app.get('/set-session', (_req, res) => {
    setSessionCookie(res, 'session-123', 1000 * 60);
    res.json({ ok: true });
  });
  app.get('/read-session', (req, res) => res.json({ id: readSessionCookie(req) ?? null }));
  app.get('/clear-session', (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });
  return app;
}

describe('auth cookies', () => {
  it('round-trips the pending registration cookie through a signed cookie jar', async () => {
    const app = buildApp();
    const agent = request.agent(app);
    await agent.get('/set-pending');
    const read = await agent.get('/read-pending');
    expect(read.body.id).toBe('pending-123');
    await agent.get('/clear-pending');
    const afterClear = await agent.get('/read-pending');
    expect(afterClear.body.id).toBeNull();
  });

  it('round-trips the session cookie through a signed cookie jar', async () => {
    const app = buildApp();
    const agent = request.agent(app);
    await agent.get('/set-session');
    const read = await agent.get('/read-session');
    expect(read.body.id).toBe('session-123');
    await agent.get('/clear-session');
    const afterClear = await agent.get('/read-session');
    expect(afterClear.body.id).toBeNull();
  });

  it('readPendingRegCookie returns undefined when no cookie is present', async () => {
    const app = buildApp();
    const res = await request(app).get('/read-pending');
    expect(res.body.id).toBeNull();
  });

  it('cookie names are exported constants', () => {
    expect(PENDING_REG_COOKIE).toBe('pendingRegId');
    expect(SESSION_COOKIE).toBe('sessionId');
  });

  it('round-trips the login challenge cookie as JSON', async () => {
    const app = buildApp();
    app.get('/set-login-challenge', (_req, res) => {
      setLoginChallengeCookie(res, { userId: 'user-1', challenge: 'chal-1' });
      res.json({ ok: true });
    });
    app.get('/read-login-challenge', (req, res) => res.json(readLoginChallengeCookie(req) ?? null));
    app.get('/clear-login-challenge', (_req, res) => {
      clearLoginChallengeCookie(res);
      res.json({ ok: true });
    });
    const agent = request.agent(app);
    await agent.get('/set-login-challenge');
    const read = await agent.get('/read-login-challenge');
    expect(read.body).toEqual({ userId: 'user-1', challenge: 'chal-1' });
    await agent.get('/clear-login-challenge');
    expect((await agent.get('/read-login-challenge')).body).toBeNull();
  });

  describe('Secure flag', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('omits Secure in non-production (e.g. local dev over plain HTTP)', async () => {
      process.env.NODE_ENV = 'test';
      const app = buildApp();
      const res = await request(app).get('/set-session');
      const setCookie = res.headers['set-cookie'] as unknown as string[];
      expect(setCookie[0]).not.toMatch(/Secure/i);
    });

    it('sets Secure in production', async () => {
      process.env.NODE_ENV = 'production';
      const app = buildApp();
      const res = await request(app).get('/set-session');
      const setCookie = res.headers['set-cookie'] as unknown as string[];
      expect(setCookie[0]).toMatch(/Secure/i);
    });
  });
});
