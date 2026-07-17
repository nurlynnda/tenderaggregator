import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { readSessionCookie } from './cookies.js';
import type { SessionRepository } from './sessionRepository.js';
import type { UserDoc } from './types.js';
import type { UserRepository } from './userRepository.js';

export interface AuthedRequest extends Request {
  user?: UserDoc;
}

export function requireAuth(sessions: SessionRepository, users: UserRepository, sessionTtlMs: number): RequestHandler {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const sessionId = readSessionCookie(req);
    if (!sessionId) return res.status(401).json({ error: 'not authenticated' });

    const session = await sessions.findById(sessionId);
    if (!session) return res.status(401).json({ error: 'not authenticated' });

    const user = await users.findById(session.userId);
    if (!user) return res.status(401).json({ error: 'not authenticated' });

    await sessions.touch(sessionId, sessionTtlMs);
    req.user = user;
    next();
  };
}

export function requireAdmin(): RequestHandler {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    next();
  };
}
