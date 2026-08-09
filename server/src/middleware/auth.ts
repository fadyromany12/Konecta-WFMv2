import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getUser, type UserRow } from '../services/people.js';
import { SUPERVISOR_ROLES, type Role } from '../domain/reference.js';
import { effectiveStatus } from '../domain/org.js';
import { todayStr } from '../domain/time.js';

const SECRET = process.env.PULSE_SECRET ?? 'konecta-pulse-development-secret';
const TOKEN_TTL = '12h';

// The fallback keeps local development frictionless, but anyone who can read
// the source can mint a token with it. Say so loudly anywhere that is not a
// developer's own machine.
if (!process.env.PULSE_SECRET && (process.env.VERCEL || process.env.NODE_ENV === 'production')) {
  console.warn(
    'WARNING: PULSE_SECRET is not set, so session tokens are signed with the public development secret. ' +
      'Set PULSE_SECRET before this deployment holds anything that matters.',
  );
}

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

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Sign in to continue.' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), SECRET) as { sub: string };
    const user = await getUser(Number(payload.sub));
    if (!user) {
      res.status(401).json({ error: 'Account no longer exists.' });
      return;
    }
    // Access mirrors employment status: a user on leave or terminated in the HR
    // feed loses access, which is the single most common cause of a blocked
    // sign-in and worth saying plainly rather than as a generic error.
    //
    // Read through `effectiveStatus` rather than off the row, so a leaver's
    // twelve-hour token stops working the morning after their last day instead
    // of lasting until it expires on its own.
    const status = effectiveStatus(user, todayStr());
    if (status !== 'ACTIVE') {
      res.status(403).json({
        error: `Your employment status is ${status}. Access is restricted until your HR record shows Active.`,
      });
      return;
    }
    if (mustChangePasswordFirst(user, req)) {
      res.status(403).json({
        error: 'Choose a new password before continuing.',
        mustChangePassword: true,
      });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    // A rejected token and an unreachable database are different failures and
    // must not both read as "sign in again", or an outage looks like a expired
    // session and everybody re-authenticates into the same wall.
    if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Your session has expired. Sign in again.' });
      return;
    }
    next(err);
  }
}

/**
 * The same check, but willing to read the token from the query string.
 *
 * `EventSource` cannot set request headers, so a browser has no way to send a
 * bearer token on an SSE connection. Putting a credential in a URL is worse
 * than putting it in a header — URLs end up in access logs and referrers — so
 * this is deliberately not the default: only the read-only event stream uses
 * it, and the token it accepts is the same short-lived session token that
 * expires in twelve hours.
 */
export function authenticateStream(req: Request, res: Response, next: NextFunction): void {
  if (!req.headers.authorization && typeof req.query.token === 'string') {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  void authenticate(req, res, next);
}

/**
 * Refuse everything except changing the password, when the password was issued
 * by us rather than chosen by them.
 *
 * This is what makes a temporary password single-use. Without it, an account
 * created with a password read down a phone stays usable with that password for
 * as long as nobody gets round to changing it, and the "temporary" in the name
 * is decoration.
 *
 * It lives inside `authenticate` rather than as its own middleware because that
 * is the one place every authenticated route already passes through — three
 * routers, each mounted twice, and a gate that has to be remembered per-route
 * is a gate somebody forgets.
 *
 * Matched against the end of the URL because the same routers are mounted at
 * both `/api` and the root, so the path a handler sees depends on which mount
 * the request came through.
 */
const ALLOWED_WHILE_MUST_CHANGE = ['/auth/me', '/auth/password', '/catalog'];

function mustChangePasswordFirst(user: UserRow, req: Request): boolean {
  if (!(user as unknown as { must_change_password?: number }).must_change_password) return false;
  const path = req.path.replace(/\/+$/, '');
  return !ALLOWED_WHILE_MUST_CHANGE.some((allowed) => path.endsWith(allowed));
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
