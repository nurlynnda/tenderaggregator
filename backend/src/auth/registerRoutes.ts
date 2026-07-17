import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../api/asyncHandler.js';
import { readPendingRegCookie, setPendingRegCookie, clearPendingRegCookie, setSessionCookie } from './cookies.js';
import { generateOtp, hashOtp, verifyOtp } from './otp.js';
import type { EmailSender } from './emailSender.js';
import type { PendingRegistrationRepository } from './pendingRegistrationRepository.js';
import type { RateLimiter } from './rateLimiter.js';
import type { SessionRepository } from './sessionRepository.js';
import type { UserRepository } from './userRepository.js';
import type { WebAuthnService } from './webauthnService.js';

const RequestSchema = z.object({ name: z.string().min(1), email: z.string().email() });
const VerifyOtpSchema = z.object({ otp: z.string().length(6) });
const PasskeyVerifySchema = z.object({ response: z.record(z.string(), z.unknown()) });

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 3;

export function createRegisterRoutes(deps: {
  pendingRegistrations: PendingRegistrationRepository;
  users: UserRepository;
  sessions: SessionRepository;
  email: EmailSender;
  webauthn: WebAuthnService;
  rateLimiter: RateLimiter;
  adminEmail: string;
  sessionTtlMs: number;
  now?: () => Date;
}): Router {
  const now = deps.now ?? (() => new Date());
  const router = Router();

  router.post('/request', ah(async (req, res) => {
    const parsed = RequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    if (!deps.rateLimiter.consume(`register:${req.ip}`, { limit: 3, windowMs: 60 * 60 * 1000 })) {
      return res.status(429).json({ error: 'too many registration attempts, try again later' });
    }

    const otp = generateOtp();
    const expiresAt = new Date(now().getTime() + OTP_TTL_MS);
    const pending = await deps.pendingRegistrations.create({
      name: parsed.data.name,
      email: parsed.data.email,
      otpHash: hashOtp(otp),
      expiresAt,
    });
    setPendingRegCookie(res, pending._id);
    await deps.email.send({
      to: deps.adminEmail,
      subject: 'New registration OTP',
      text: `${parsed.data.name} (${parsed.data.email}) is requesting access. OTP: ${otp}`,
    });
    res.status(202).json({ ok: true });
  }));

  router.post('/verify-otp', ah(async (req, res) => {
    const parsed = VerifyOtpSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const pendingId = readPendingRegCookie(req);
    const pending = pendingId ? await deps.pendingRegistrations.findById(pendingId) : null;
    if (!pending || pending.expiresAt <= now()) {
      clearPendingRegCookie(res);
      return res.status(400).json({ error: 'no pending registration' });
    }

    if (!verifyOtp(parsed.data.otp, pending.otpHash)) {
      const attempts = await deps.pendingRegistrations.incrementAttempts(pending._id);
      if (attempts >= MAX_OTP_ATTEMPTS) {
        await deps.pendingRegistrations.delete(pending._id);
        clearPendingRegCookie(res);
        return res.status(410).json({ error: 'too many wrong attempts, request a new code' });
      }
      return res.status(400).json({ error: 'wrong code' });
    }

    await deps.pendingRegistrations.markVerified(pending._id);
    res.json({ ok: true });
  }));

  router.post('/passkey/options', ah(async (req, res) => {
    const pendingId = readPendingRegCookie(req);
    const pending = pendingId ? await deps.pendingRegistrations.findById(pendingId) : null;
    if (!pending || !pending.verified) return res.status(400).json({ error: 'no verified pending registration' });

    const options = await deps.webauthn.generateRegistrationOptions({ userId: pending._id, email: pending.email });
    await deps.pendingRegistrations.setChallenge(pending._id, options.challenge);
    res.json(options);
  }));

  router.post('/passkey/verify', ah(async (req, res) => {
    const parsed = PasskeyVerifySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const pendingId = readPendingRegCookie(req);
    const pending = pendingId ? await deps.pendingRegistrations.findById(pendingId) : null;
    if (!pending || !pending.verified || !pending.challenge) {
      return res.status(400).json({ error: 'no verified pending registration' });
    }

    const result = await deps.webauthn.verifyRegistration({
      response: parsed.data.response as never,
      expectedChallenge: pending.challenge,
    });
    if (!result.verified || !result.credential) return res.status(400).json({ error: 'passkey verification failed' });

    const existingUser = await deps.users.findByEmail(pending.email);
    if (existingUser) return res.status(409).json({ error: 'an account with that email already exists' });

    const role = pending.email.toLowerCase() === deps.adminEmail.toLowerCase() ? 'admin' : 'member';
    const user = await deps.users.create({ name: pending.name, email: pending.email, role, credential: result.credential });
    await deps.pendingRegistrations.delete(pending._id);
    clearPendingRegCookie(res);

    const session = await deps.sessions.create(user._id, deps.sessionTtlMs);
    setSessionCookie(res, session._id, deps.sessionTtlMs);
    res.json({ user: { name: user.name, email: user.email, role: user.role } });
  }));

  return router;
}
