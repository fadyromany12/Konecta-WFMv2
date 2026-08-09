/**
 * Joiners, movers and leavers — the rules, with no database in sight.
 *
 * Three things make this more than a form. A reporting line is a tree and
 * nothing here may turn it into a ring. A role change is a privilege change, so
 * who may make one is a rule rather than a preference. And a leaver keeps
 * working until the end of their last day, which means "deactivate" is a date,
 * not a button somebody has to remember to press at midnight.
 */

import { ROLES, type Role } from './reference.js';
import type { DateStr } from './time.js';

/**
 * Employment status, mirroring the HR record.
 *
 * Only ACTIVE reaches the application. The rest are distinct because the reason
 * someone is locked out is the first thing they ask about, and "your status is
 * ON_LEAVE" answers it where a generic refusal does not.
 */
export const EMPLOYMENT_STATUSES = ['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED'] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export const STATUS_LABELS: Record<EmploymentStatus, string> = {
  ACTIVE: 'Active',
  ON_LEAVE: 'On long-term leave',
  SUSPENDED: 'Suspended',
  TERMINATED: 'Left the business',
};

/**
 * Who may create, move or end whose employment.
 *
 * An Operations Manager runs a floor and needs to onboard and offboard the
 * people on it without waiting for IT. They cannot mint another Operations
 * Manager or an Administrator, because that is how a floor-level account
 * quietly becomes a system-level one. Only an Administrator crosses that line,
 * and Team Leaders do not administer records at all — they supervise people,
 * which is a different thing and already covered by `canManage`.
 */
const ADMINISTRABLE: Partial<Record<Role, readonly Role[]>> = {
  ADMIN: ROLES,
  OPS_MANAGER: ['ADVISOR', 'TEAM_LEADER', 'TRAINER'],
};

export function canAdminister(actorRole: Role, targetRole: Role): boolean {
  return (ADMINISTRABLE[actorRole] ?? []).includes(targetRole);
}

/** The roles somebody may hand out, which is exactly the set they may administer. */
export function assignableRoles(actorRole: Role): Role[] {
  return [...(ADMINISTRABLE[actorRole] ?? [])];
}

/**
 * Would pointing `userId` at `newManagerId` close a loop?
 *
 * Walks up from the proposed manager looking for the user. A ring in the
 * reporting tree is not a cosmetic problem: `descendantsOf` and every visibility
 * question built on it walk children until they run out, and a ring means they
 * never do. The guard belongs here rather than in a query because it has to be
 * answered about a state that does not exist yet.
 *
 * Self-management is the one-step case of the same thing and is refused by the
 * same walk.
 */
export function wouldCycle(
  managerOf: ReadonlyMap<number, number | null>,
  userId: number,
  newManagerId: number | null,
): boolean {
  let cursor = newManagerId;
  const seen = new Set<number>();
  while (cursor !== null && cursor !== undefined) {
    if (cursor === userId) return true;
    // A ring that already exists elsewhere in the tree would otherwise spin
    // here forever. It is not this change's fault, but this change must still
    // terminate.
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = managerOf.get(cursor) ?? null;
  }
  return false;
}

export interface LeaverPlan {
  /** Last working day, inclusive. Access ends after it, not on it. */
  leaveDate: DateStr;
  status: EmploymentStatus;
}

/**
 * The status a record actually has today, given a planned leave date.
 *
 * Stored status and effective status differ on purpose for the window between
 * a resignation being recorded and the person's last day. A leaver who is told
 * on Monday that Friday is their last day still has four days of shifts to work
 * and timecards to check, and locking them out on Monday is the most common way
 * an offboarding goes wrong. The stored row keeps saying ACTIVE; this function
 * is what turns it off, once, on Saturday morning, without anybody running a job.
 *
 * A status that is already something other than ACTIVE wins outright — a
 * suspension is a decision about today and is not waiting for a date.
 */
export function effectiveStatus(
  user: { status: string; leave_date?: string | null },
  today: DateStr,
): EmploymentStatus {
  const stored = (EMPLOYMENT_STATUSES as readonly string[]).includes(user.status)
    ? (user.status as EmploymentStatus)
    : 'ACTIVE';
  if (stored !== 'ACTIVE') return stored;
  if (user.leave_date && today > user.leave_date) return 'TERMINATED';
  return 'ACTIVE';
}

/** Whether a record may sign in today. */
export function hasAccess(user: { status: string; leave_date?: string | null }, today: DateStr): boolean {
  return effectiveStatus(user, today) === 'ACTIVE';
}

export interface NewUserInput {
  employeeId: string;
  name: string;
  email: string;
  role: Role;
  managerId: number | null;
  projectId: string | null;
  departmentCode: string;
  shiftRule: string;
  hireDate: string | null;
  region: string;
}

/**
 * What is wrong with a proposed record, in the words the person filling the
 * form would use.
 *
 * Returns every problem rather than the first, because a form that reveals one
 * fault per submission is how a five-field mistake becomes five round trips.
 */
export function validateNewUser(input: Partial<NewUserInput>): string[] {
  const problems: string[] = [];

  const employeeId = (input.employeeId ?? '').trim();
  if (!employeeId) problems.push('An employee ID is required.');
  else if (!/^[A-Za-z0-9._-]{2,32}$/.test(employeeId)) {
    problems.push('An employee ID may use letters, digits, dots, dashes and underscores only.');
  }

  const name = (input.name ?? '').trim();
  if (name.length < 2) problems.push('A full name is required.');

  const email = (input.email ?? '').trim();
  // Deliberately permissive. The purpose is to catch a typo, not to adjudicate
  // RFC 5322 — an over-strict pattern rejects real addresses and teaches people
  // to work around the form.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push('A valid email address is required.');

  if (!input.role || !ROLES.includes(input.role)) problems.push('A role is required.');

  // An advisor with no manager is invisible: every supervisory view is derived
  // from the reporting line, so nobody would ever see them on a roster.
  if (input.role === 'ADVISOR' && !input.managerId) {
    problems.push('An advisor needs a manager, or nobody will see them on a roster.');
  }

  if (input.hireDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.hireDate)) {
    problems.push('A hire date must be a YYYY-MM-DD date.');
  }

  return problems;
}

/** Normalised for storage: emails lowercased, everything trimmed. */
export function normaliseNewUser(input: NewUserInput): NewUserInput {
  return {
    ...input,
    employeeId: input.employeeId.trim(),
    name: input.name.trim().replace(/\s+/g, ' '),
    email: input.email.trim().toLowerCase(),
  };
}

/**
 * A first password nobody has to invent.
 *
 * Deliberately readable aloud, because it is handed over in person or by phone
 * on somebody's first morning and a password that cannot be dictated gets
 * written on a sticky note. It is single-use — the account it belongs to cannot
 * do anything until it has been changed — so its job is to survive one
 * conversation, not to be a lasting secret.
 *
 * Ambiguous characters are excluded: nobody should have to ask whether that was
 * a one or an ell.
 */
const SAY_ABLE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function temporaryPassword(random: () => number = Math.random): string {
  const pick = () => SAY_ABLE[Math.floor(random() * SAY_ABLE.length)];
  const group = () => Array.from({ length: 4 }, pick).join('');
  return `${group()}-${group()}-${group()}`;
}
