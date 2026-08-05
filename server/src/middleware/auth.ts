import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getUser, type UserRow } from '../services/people.js';
import { SUPERVISOR_ROLES, type Role } from '../domain/reference.js';

const SECRET = process.env.PULSE_SECRET ?? 'konecta-pulse-development-secret';
const TOKEN_TTL = '12h';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}

export function signToken(userId: number): string {
  return jwt.sign({ sub: String(userId) }, SECRET, { expiresIn: TOKEN_TTL });
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Sign in to continue.' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), SECRET) as { sub: string };
    const user = getUser(Number(payload.sub));
    if (!user) {
      res.status(401).json({ error: 'Account no longer exists.' });
      return;
    }
    // Access mirrors employment status: a user on leave or terminated in the HR
    // feed loses access, which is the single most common cause of a blocked
    // sign-in and worth saying plainly rather than as a generic error.
    if (user.status !== 'ACTIVE') {
      res.status(403).json({
        error: `Your employment status is ${user.status}. Access is restricted until your HR record shows Active.`,
      });
      return;
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Your role does not have access to this function.' });
      return;
    }
    next();
  };
}

export const requireSupervisor = requireRole(...SUPERVISOR_ROLES);
