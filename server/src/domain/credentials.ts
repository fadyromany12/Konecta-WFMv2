/**
 * Password rules and lockout, with no database and no clock of its own.
 *
 * Two decisions are worth stating, because both go against a common default.
 *
 * The strength rule counts length first and character classes not at all.
 * Mandatory symbols and digits produce `Password1!` on every floor in the
 * world; length is what actually costs an attacker something, and a rule people
 * can satisfy honestly is worth more than one they satisfy by ritual.
 *
 * Lockout is a delay that grows, not a door that shuts. An account locked
 * permanently after five wrong guesses is a denial-of-service anybody can
 * perform on anybody, and on a contact centre floor it is also a supervisor
 * locked out mid-shift with a queue building. The delay reaches a minute after
 * five attempts and fifteen after ten, which is ruinous for a script and
 * survivable for somebody whose caps lock was on.
 */

import { addMinutes, type Stamp } from './time.js';

/**
 * Long enough to matter, short enough to be a passphrase rather than a puzzle.
 * Three words are 12-20 characters and are far stronger than anything a symbol
 * requirement would have produced.
 */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * The most-guessed passwords, lowercased. Not a serious dictionary — the point
 * is to catch the handful somebody types when they have decided the rule is
 * stupid, which on a floor of fifty people is a certainty rather than a risk.
 */
const OBVIOUS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '1234567890',
  '12345678910',
  'qwertyuiop',
  'letmein123',
  'iloveyou123',
  'welcome123',
  'konecta123',
  'konectapulse',
  'changeme123',
  'administrator',
]);

export interface Identity {
  email?: string | null;
  name?: string | null;
  employeeId?: string | null;
}

/**
 * What is wrong with a proposed password, in the words the person choosing it
 * would use. Empty means it is acceptable.
 *
 * Every problem is returned at once, for the same reason as the joiner form:
 * one fault per attempt turns a single decision into four.
 */
export function passwordProblems(password: string, identity: Identity = {}): string[] {
  const problems: string[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters. A short phrase is ideal.`);
  }
  // A trimmed length below the minimum means the length was made up of spaces.
  if (password.trim().length < MIN_PASSWORD_LENGTH && password.length >= MIN_PASSWORD_LENGTH) {
    problems.push('Spaces alone do not make a password longer in any way that helps.');
  }

  const lower = password.toLowerCase();
  if (OBVIOUS.has(lower)) problems.push('That is one of the most commonly guessed passwords.');

  // A single repeated character passes any length rule and no other test.
  if (password.length > 0 && new Set(password).size <= 2) {
    problems.push('Use more than one or two different characters.');
  }

  const localPart = (identity.email ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (localPart.length >= 3 && lower.includes(localPart)) {
    problems.push('A password should not contain your email address.');
  }

  const employeeId = (identity.employeeId ?? '').toLowerCase();
  if (employeeId.length >= 3 && lower.includes(employeeId)) {
    problems.push('A password should not contain your employee ID.');
  }

  // Any single name part, so "Nour" is caught in "nourpassword" without
  // demanding the whole "Nour Adel" appear.
  for (const part of (identity.name ?? '').toLowerCase().split(/\s+/)) {
    if (part.length >= 3 && lower.includes(part)) {
      problems.push('A password should not contain your own name.');
      break;
    }
  }

  return problems;
}

/**
 * How long an account is locked after this many consecutive failures.
 *
 * Null for the first four, so an ordinary typo costs nothing at all. After
 * that it climbs, and it is capped: a permanent lock would be a weapon rather
 * than a defence.
 */
export function lockoutMinutes(consecutiveFailures: number): number | null {
  if (consecutiveFailures < 5) return null;
  if (consecutiveFailures < 7) return 1;
  if (consecutiveFailures < 10) return 5;
  return 15;
}

export interface LockState {
  failed_logins?: number | null;
  locked_until?: string | null;
}

/** Whether an account is inside a lockout window at this instant. */
export function isLocked(state: LockState, now: Stamp): boolean {
  return !!state.locked_until && state.locked_until > now;
}

/**
 * The account state after one more failed attempt.
 *
 * Returned rather than applied, so the caller writes it in whatever transaction
 * it already has and this stays testable without a database.
 */
export function afterFailure(state: LockState, now: Stamp): { failedLogins: number; lockedUntil: string | null } {
  const failedLogins = (state.failed_logins ?? 0) + 1;
  const minutes = lockoutMinutes(failedLogins);
  return {
    failedLogins,
    // An existing lock is never shortened by a further wrong guess.
    lockedUntil: minutes === null ? (state.locked_until ?? null) : addMinutes(now, minutes),
  };
}

/**
 * How long until a lock lifts, in whole minutes rounded up, for telling
 * somebody how long they have to wait. Zero when it has already lifted.
 */
export function minutesRemaining(state: LockState, now: Stamp): number {
  if (!state.locked_until || state.locked_until <= now) return 0;
  const [date, time] = state.locked_until.split(' ');
  const [nowDate, nowTime] = now.split(' ');
  const asMinutes = (d: string, t: string) => {
    const [y, m, day] = d.split('-').map(Number);
    const [hh, mm] = t.split(':').map(Number);
    return Date.UTC(y, m - 1, day, hh, mm) / 60000;
  };
  return Math.max(1, Math.ceil(asMinutes(date, time) - asMinutes(nowDate, nowTime)));
}
