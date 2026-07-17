import { Router } from 'express';
import { z } from 'zod';
import {
  clearLoginChallengeCookie,
  clearSessionCookie,
  readLoginChallengeCookie,
  readSessionCookie,
  setLoginChallengeCookie,
  setSessionCookie,
} from './cookies.js';
import { requireAuth } from './middleware.js';
import type { SessionRepository } from './sessionRepository.js';
import type { UserRepository } from './userRepository.js';
import type { WebAuthnService } from './webauthnService.js';

const EmailSchema = z.object({ email: z.string().email() });
const VerifySchema = z.object({ email: z.string().email(), response: z.record(z.string(), z.unknown()) });

export function createLoginRoutes(deps: {
  users: UserRepository;
  sessions: SessionRepository;
  webauthn: WebAuthnService;
  sessionTtlMs: number;
}): Router {
  const router = Router();

  router.post('/login/options', async (req, res) => {
    const parsed = EmailSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const user = await deps.users.findByEmail(parsed.data.email);
    if (!user) return res.status(404).json({ error: 'no account with that email' });

    const options = await deps.webauthn.generateAuthenticationOptions({ credential: user.credential });
    setLoginChallengeCookie(res, { userId: user._id, challenge: options.challenge });
    res.json(options);
  });

  router.post('/login/verify', async (req, res) => {
    const parsed = VerifySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const challengeCookie = readLoginChallengeCookie(req);
    const user = await deps.users.findByEmail(parsed.data.email);
    if (!user || !challengeCookie || challengeCookie.userId !== user._id) {
      return res.status(400).json({ error: 'no login in progress for this email' });
    }

    const result = await deps.webauthn.verifyAuthentication({
      response: parsed.data.response as never,
      expectedChallenge: challengeCookie.challenge,
      credential: user.credential,
    });
    clearLoginChallengeCookie(res);
    if (!result.verified) return res.status(401).json({ error: 'passkey verification failed' });

    if (result.newCounter !== undefined) await deps.users.updateCredentialCounter(user._id, result.newCounter);

    const session = await deps.sessions.create(user._id, deps.sessionTtlMs);
    setSessionCookie(res, session._id, deps.sessionTtlMs);
    res.json({ user: { name: user.name, email: user.email, role: user.role } });
  });

  router.post('/logout', async (req, res) => {
    const sessionId = readSessionCookie(req);
    if (sessionId) await deps.sessions.delete(sessionId);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', requireAuth(deps.sessions, deps.users, deps.sessionTtlMs), (req, res) => {
    const user = (req as unknown as { user: { name: string; email: string; role: string } }).user;
    res.json({ name: user.name, email: user.email, role: user.role });
  });

  return router;
}
