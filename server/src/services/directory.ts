/**
 * The directory: who exists, who they report to, and how they prove it is them.
 *
 * Everything here changes a person's record, so everything here is audited and
 * most of it is refused for somebody. The rules themselves live in
 * `domain/org.ts` and `domain/credentials.ts`; this is the part that knows where
 * the rows are and what else has to move when one changes.
 */

import bcrypt from 'bcryptjs';
import { audit, db, transact } from '../db/index.js';
import {
  canAdminister,
  effectiveStatus,
  normaliseNewUser,
  temporaryPassword,
  validateNewUser,
  wouldCycle,
  type EmploymentStatus,
  type NewUserInput,
} from '../domain/org.js';
import { afterFailure, isLocked, minutesRemaining, passwordProblems } from '../domain/credentials.js';
import { DEFAULT_SHIFT_RULE, type Role } from '../domain/reference.js';
import { nowStamp, todayStr, type DateStr } from '../domain/time.js';
import { getUser, type UserRow } from './people.js';

/** Raised for anything a person did wrong, as opposed to anything we did. */
export class DirectoryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly problems: string[] = [],
  ) {
    super(message);
  }
}

const BCRYPT_ROUNDS = 10;

/** The whole reporting line as child → parent, for the cycle check. */
async function managerMap(): Promise<Map<number, number | null>> {
  const rows = await db.all<{ id: number; manager_id: number | null }>(
    'SELECT id, manager_id FROM users',
  );
  return new Map(rows.map((r) => [r.id, r.manager_id]));
}

// ------------------------------------------------------------------ joiners

export interface CreatedPerson {
  id: number;
  employeeId: string;
  name: string;
  email: string;
  /**
   * Returned exactly once, in the response to the request that created the
   * account, and never stored in readable form. If it is lost, the fix is a
   * reset — which is cheap — rather than a lookup, which would mean we had kept
   * it, which would be the actual problem.
   */
  temporaryPassword: string;
}

export async function createPerson(actor: UserRow, input: NewUserInput): Promise<CreatedPerson> {
  if (!canAdminister(actor.role, input.role)) {
    throw new DirectoryError(`Your role cannot create a ${input.role.toLowerCase().replace('_', ' ')}.`, 403);
  }

  const problems = validateNewUser(input);
  if (problems.length > 0) throw new DirectoryError('That record is not complete.', 400, problems);

  const person = normaliseNewUser(input);

  // Checked before writing so the message names the field. The unique
  // constraints underneath are the real guarantee — this is the part that turns
  // a constraint violation into a sentence.
  const [byEmail, byEmployeeId] = await Promise.all([
    db.get<{ id: number }>('SELECT id FROM users WHERE lower(email) = lower(?)', [person.email]),
    db.get<{ id: number }>('SELECT id FROM users WHERE employee_id = ?', [person.employeeId]),
  ]);
  if (byEmail) throw new DirectoryError('Somebody already has that email address.', 409);
  if (byEmployeeId) throw new DirectoryError('Somebody already has that employee ID.', 409);

  if (person.managerId !== null) {
    const manager = await getUser(person.managerId);
    if (!manager) throw new DirectoryError('That manager does not exist.', 400);
  }

  const password = temporaryPassword();
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

  const id = await transact(async () => {
    const newId = await db.insert(
      `INSERT INTO users
         (employee_id, name, email, password_hash, role, manager_id, project_id,
          department_code, status, shift_rule, region, hire_date, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, 1, ?)`,
      [
        person.employeeId,
        person.name,
        person.email,
        hash,
        person.role,
        person.managerId,
        person.projectId,
        person.departmentCode || '10000',
        person.shiftRule || DEFAULT_SHIFT_RULE,
        person.region || 'EMEA',
        person.hireDate,
        nowStamp(),
      ],
    );
    await audit(actor.id, 'user', newId, 'CREATE_USER', {
      employeeId: person.employeeId,
      name: person.name,
      role: person.role,
      managerId: person.managerId,
      projectId: person.projectId,
    });
    return newId;
  });

  return {
    id,
    employeeId: person.employeeId,
    name: person.name,
    email: person.email,
    temporaryPassword: password,
  };
}

// ------------------------------------------------------------------- movers

export interface PersonChanges {
  name?: string;
  email?: string;
  role?: Role;
  managerId?: number | null;
  projectId?: string | null;
  departmentCode?: string;
  shiftRule?: string;
  region?: string;
  hireDate?: string | null;
  status?: EmploymentStatus;
}

const FIELD_COLUMNS: Record<keyof PersonChanges, string> = {
  name: 'name',
  email: 'email',
  role: 'role',
  managerId: 'manager_id',
  projectId: 'project_id',
  departmentCode: 'department_code',
  shiftRule: 'shift_rule',
  region: 'region',
  hireDate: 'hire_date',
  status: 'status',
};

/**
 * Change somebody's record — which for most of the volume means moving them to
 * a different team.
 *
 * Only the fields actually supplied are written, so a screen that sends the
 * whole record back cannot silently revert a field it did not show.
 */
export async function updatePerson(
  actor: UserRow,
  targetId: number,
  changes: PersonChanges,
): Promise<{ changed: string[] }> {
  const target = await getUser(targetId);
  if (!target) throw new DirectoryError('No such employee.', 404);

  if (!canAdminister(actor.role, target.role)) {
    throw new DirectoryError('Your role cannot change that employee.', 403);
  }
  // Changing your own role or reporting line is the shortest route from a
  // floor-level account to a system-level one, so it is refused outright even
  // for an administrator. Somebody else does it, and the audit trail has two
  // names in it.
  if (actor.id === targetId && (changes.role !== undefined || changes.managerId !== undefined)) {
    throw new DirectoryError('You cannot change your own role or reporting line.', 403);
  }
  if (changes.role !== undefined && !canAdminister(actor.role, changes.role)) {
    throw new DirectoryError(`Your role cannot grant the ${changes.role.toLowerCase().replace('_', ' ')} role.`, 403);
  }

  if (changes.managerId !== undefined && changes.managerId !== null) {
    const manager = await getUser(changes.managerId);
    if (!manager) throw new DirectoryError('That manager does not exist.', 400);
    if (wouldCycle(await managerMap(), targetId, changes.managerId)) {
      throw new DirectoryError(
        'That would make the reporting line into a loop — they would end up reporting to themselves.',
        400,
      );
    }
  }

  if (changes.email !== undefined) {
    const clash = await db.get<{ id: number }>(
      'SELECT id FROM users WHERE lower(email) = lower(?) AND id <> ?',
      [changes.email, targetId],
    );
    if (clash) throw new DirectoryError('Somebody already has that email address.', 409);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  const changed: string[] = [];
  const before: Record<string, unknown> = {};

  for (const [field, column] of Object.entries(FIELD_COLUMNS) as [keyof PersonChanges, string][]) {
    const value = changes[field];
    if (value === undefined) continue;
    const current = (target as unknown as Record<string, unknown>)[column];
    if (current === value) continue;
    sets.push(`${column} = ?`);
    values.push(field === 'email' && typeof value === 'string' ? value.trim().toLowerCase() : value);
    changed.push(field);
    before[field] = current;
  }

  if (sets.length === 0) return { changed: [] };

  await transact(async () => {
    await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...values, targetId]);
    await audit(actor.id, 'user', targetId, 'UPDATE_USER', { changed, before, after: changes });
  });

  return { changed };
}

// ------------------------------------------------------------------ leavers

/**
 * Record a leaving date.
 *
 * The row keeps saying ACTIVE. `effectiveStatus` is what turns access off, the
 * morning after the last working day — so a notice period stays workable and
 * nobody has to remember to run anything at midnight.
 *
 * Anyone still reporting to a leaver has to be moved first. An orphaned team is
 * invisible: every supervisory view is derived from the reporting line, so
 * fifteen advisors under a departed team leader vanish from the roster nobody
 * is now looking at.
 */
export async function recordLeaver(
  actor: UserRow,
  targetId: number,
  leaveDate: DateStr,
): Promise<{ reports: number; effectiveFrom: DateStr }> {
  const target = await getUser(targetId);
  if (!target) throw new DirectoryError('No such employee.', 404);
  if (!canAdminister(actor.role, target.role)) {
    throw new DirectoryError('Your role cannot end that employment.', 403);
  }
  if (actor.id === targetId) {
    throw new DirectoryError('You cannot record your own leaving date here.', 403);
  }

  const reports = await db.all<{ id: number; name: string }>(
    'SELECT id, name FROM users WHERE manager_id = ? AND status = ?',
    [targetId, 'ACTIVE'],
  );
  if (reports.length > 0) {
    throw new DirectoryError(
      `${reports.length} ${reports.length === 1 ? 'person still reports' : 'people still report'} to ${target.name}. ` +
        'Move them to another manager first, or they will disappear from every roster.',
      409,
      reports.map((r) => r.name),
    );
  }

  await transact(async () => {
    await db.run('UPDATE users SET leave_date = ? WHERE id = ?', [leaveDate, targetId]);
    await audit(actor.id, 'user', targetId, 'RECORD_LEAVER', { leaveDate, was: target.leave_date ?? null });
  });

  return { reports: 0, effectiveFrom: leaveDate };
}

/** Undo a leaving date, or bring somebody back from a non-active status. */
export async function reinstate(actor: UserRow, targetId: number): Promise<void> {
  const target = await getUser(targetId);
  if (!target) throw new DirectoryError('No such employee.', 404);
  if (!canAdminister(actor.role, target.role)) {
    throw new DirectoryError('Your role cannot reinstate that employee.', 403);
  }

  await transact(async () => {
    await db.run(
      "UPDATE users SET leave_date = NULL, status = 'ACTIVE', failed_logins = 0, locked_until = NULL WHERE id = ?",
      [targetId],
    );
    await audit(actor.id, 'user', targetId, 'REINSTATE', {
      wasStatus: target.status,
      wasLeaveDate: target.leave_date ?? null,
    });
  });
}

/** Set a status directly — a suspension or a long-term leave, effective now. */
export async function setStatus(
  actor: UserRow,
  targetId: number,
  status: EmploymentStatus,
): Promise<void> {
  const target = await getUser(targetId);
  if (!target) throw new DirectoryError('No such employee.', 404);
  if (!canAdminister(actor.role, target.role)) {
    throw new DirectoryError('Your role cannot change that employee.', 403);
  }
  if (actor.id === targetId && status !== 'ACTIVE') {
    throw new DirectoryError('You cannot lock yourself out.', 403);
  }

  await transact(async () => {
    await db.run('UPDATE users SET status = ? WHERE id = ?', [status, targetId]);
    await audit(actor.id, 'user', targetId, 'SET_STATUS', { status, was: target.status });
  });
}

// -------------------------------------------------------------- credentials

/**
 * Change your own password.
 *
 * The current password is required even though the caller is already
 * authenticated, because a session left open on a shared floor machine is the
 * exact circumstance this protects against — and on a contact centre floor,
 * machines are shared by definition.
 */
export async function changeOwnPassword(
  userId: number,
  currentPassword: string,
  nextPassword: string,
): Promise<void> {
  const user = await db.get<UserRow & { password_hash: string }>(
    'SELECT * FROM users WHERE id = ?',
    [userId],
  );
  if (!user) throw new DirectoryError('No such account.', 404);

  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    throw new DirectoryError('That is not your current password.', 403);
  }
  if (bcrypt.compareSync(nextPassword, user.password_hash)) {
    throw new DirectoryError('That is the password you are already using.', 400);
  }

  const problems = passwordProblems(nextPassword, {
    email: user.email,
    name: user.name,
    employeeId: user.employee_id,
  });
  if (problems.length > 0) throw new DirectoryError('That password cannot be used.', 400, problems);

  await transact(async () => {
    await db.run(
      `UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?,
              failed_logins = 0, locked_until = NULL
       WHERE id = ?`,
      [bcrypt.hashSync(nextPassword, BCRYPT_ROUNDS), nowStamp(), userId],
    );
    // The event, never the secret.
    await audit(userId, 'user', userId, 'CHANGE_PASSWORD', {});
  });
}

/**
 * Issue somebody a new temporary password.
 *
 * The returned password is shown to the administrator once so they can hand it
 * over. The account cannot do anything with it but change it.
 */
export async function resetPassword(actor: UserRow, targetId: number): Promise<string> {
  const target = await getUser(targetId);
  if (!target) throw new DirectoryError('No such employee.', 404);
  if (actor.id !== targetId && !canAdminister(actor.role, target.role)) {
    throw new DirectoryError('Your role cannot reset that password.', 403);
  }

  const password = temporaryPassword();
  await transact(async () => {
    await db.run(
      `UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = ?,
              failed_logins = 0, locked_until = NULL
       WHERE id = ?`,
      [bcrypt.hashSync(password, BCRYPT_ROUNDS), nowStamp(), targetId],
    );
    await audit(actor.id, 'user', targetId, 'RESET_PASSWORD', {});
  });
  return password;
}

export interface SignInOutcome {
  ok: boolean;
  user?: UserRow & { must_change_password?: number };
  /** The message to show. Deliberately vague about which half was wrong. */
  message?: string;
  status?: number;
}

/**
 * Authenticate, counting failures and honouring a lockout.
 *
 * A wrong password and an unknown address return the same sentence. Telling an
 * attacker that an address exists is how a list of guesses becomes a list of
 * targets, and the honest-user cost is close to nothing: somebody who has
 * mistyped their own email address tries it again.
 *
 * A lockout is the one thing said plainly, because "wait four minutes" is
 * actionable and a fifth identical refusal is not.
 */
export async function signIn(email: string, password: string): Promise<SignInOutcome> {
  const generic = { ok: false as const, status: 401, message: 'That email address and password do not match an account.' };

  const user = await db.get<UserRow & { password_hash: string; failed_logins: number; locked_until: string | null; must_change_password: number }>(
    'SELECT * FROM users WHERE lower(email) = lower(?)',
    [email],
  );
  if (!user) return generic;

  const now = nowStamp();
  if (isLocked(user, now)) {
    const minutes = minutesRemaining(user, now);
    return {
      ok: false,
      status: 429,
      message: `Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
    };
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    const next = afterFailure(user, now);
    await db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', [
      next.failedLogins,
      next.lockedUntil,
      user.id,
    ]);
    return generic;
  }

  const status = effectiveStatus(user, todayStr());
  if (status !== 'ACTIVE') {
    return {
      ok: false,
      status: 403,
      message: `Your employment status is ${status}. Access is restricted until your HR record shows Active.`,
    };
  }

  if (user.failed_logins > 0 || user.locked_until) {
    await db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [user.id]);
  }

  const { password_hash: _ignored, ...safe } = user;
  return { ok: true, user: safe as UserRow & { must_change_password: number } };
}
