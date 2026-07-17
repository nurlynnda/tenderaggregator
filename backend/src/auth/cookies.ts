import type { Request, Response } from 'express';

export const PENDING_REG_COOKIE = 'pendingRegId';
export const SESSION_COOKIE = 'sessionId';

// 10 minutes — matches the OTP expiry window this cookie exists to bound.
const PENDING_REG_TTL_MS = 10 * 60 * 1000;

export function setPendingRegCookie(res: Response, id: string): void {
  res.cookie(PENDING_REG_COOKIE, id, {
    httpOnly: true,
    signed: true,
    sameSite: 'strict',
    maxAge: PENDING_REG_TTL_MS,
  });
}

export function readPendingRegCookie(req: Request): string | undefined {
  const value = req.signedCookies?.[PENDING_REG_COOKIE];
  return typeof value === 'string' ? value : undefined;
}

export function clearPendingRegCookie(res: Response): void {
  res.clearCookie(PENDING_REG_COOKIE);
}

export function setSessionCookie(res: Response, id: string, ttlMs: number): void {
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    signed: true,
    sameSite: 'strict',
    maxAge: ttlMs,
  });
}

export function readSessionCookie(req: Request): string | undefined {
  const value = req.signedCookies?.[SESSION_COOKIE];
  return typeof value === 'string' ? value : undefined;
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE);
}
