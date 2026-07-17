import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { readSessionCookie } from './cookies.js';
import type { SessionRepository } from './sessionRepository.js';
import type { UserDoc } from './types.js';
import type { UserRepository } from './userRepository.js';

export interface AuthedRequest extends Request {
  user?: UserDoc;
}

export function requireAuth(
  sessions: SessionRepository,
  users: UserRepository,
  sessionTtlMs: number,
  now: () => Date = () => new Date(),
): RequestHandler {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const sessionId = readSessionCookie(req);
      if (!sessionId) return res.status(401).json({ error: 'not authenticated' });

      const session = await sessions.findById(sessionId);
      if (!session) return res.status(401).json({ error: 'not authenticated' });

      // Belt-and-braces alongside the Mongo TTL index: expiry is enforced here explicitly
      // so a leaked/stale session id is rejected immediately, without depending on TTL reaping.
      if (new Date(session.expiresAt) <= now()) return res.status(401).json({ error: 'not authenticated' });

      const user = await users.findById(session.userId);
      if (!user) return res.status(401).json({ error: 'not authenticated' });

      await sessions.touch(sessionId, sessionTtlMs);
      req.user = user;
      next();
    } catch (err) {
      // Express 4 does not auto-forward async rejections to error middleware; forward
      // explicitly so a Mongo failure here becomes a clean 500 instead of a hang.
      next(err);
    }
  };
}

export function requireAdmin(): RequestHandler {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    next();
  };
}
