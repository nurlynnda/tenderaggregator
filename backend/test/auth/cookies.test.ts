import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  clearPendingRegCookie,
  clearSessionCookie,
  PENDING_REG_COOKIE,
  readPendingRegCookie,
  readSessionCookie,
  SESSION_COOKIE,
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
});
