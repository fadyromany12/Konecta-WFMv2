import { describe, expect, it } from 'vitest';
import {
  afterFailure,
  isLocked,
  lockoutMinutes,
  minutesRemaining,
  passwordProblems,
} from '../credentials.js';

const identity = {
  email: 'nour.adel@konecta.example',
  name: 'Nour Adel',
  employeeId: 'EG-4401',
};

describe('choosing a password', () => {
  it('accepts an ordinary passphrase', () => {
    expect(passwordProblems('correct horse battery', identity)).toEqual([]);
  });

  it('accepts a long password with no symbols or digits at all', () => {
    expect(passwordProblems('thequickbrownfox', identity)).toEqual([]);
  });

  it('refuses one that is too short', () => {
    expect(passwordProblems('Sh0rt!', identity)).toHaveLength(1);
  });

  it('refuses the ones everybody guesses', () => {
    expect(passwordProblems('password123', identity).join(' ')).toContain('commonly guessed');
    expect(passwordProblems('konecta123', identity).join(' ')).toContain('commonly guessed');
  });

  it('refuses a single character repeated to length', () => {
    expect(passwordProblems('aaaaaaaaaaaa', identity).join(' ')).toContain('more than one or two');
  });

  it('refuses padding a short password with spaces', () => {
    const problems = passwordProblems('abc       ', identity).join(' ');
    expect(problems).toContain('Spaces alone');
  });

  it('refuses one containing the email local part', () => {
    expect(passwordProblems('nour.adel-is-here', identity).join(' ')).toContain('email address');
  });

  it('refuses one containing the employee ID', () => {
    expect(passwordProblems('theeg-4401thing', identity).join(' ')).toContain('employee ID');
  });

  it('refuses one containing a single part of their name', () => {
    expect(passwordProblems('nourthebrave', identity).join(' ')).toContain('your own name');
  });

  it('says everything at once', () => {
    expect(passwordProblems('nour', identity).length).toBeGreaterThanOrEqual(2);
  });

  it('does not trip over a short name part', () => {
    expect(passwordProblems('somethinglongenough', { name: 'Jo Ng' })).toEqual([]);
  });

  it('needs no identity at all', () => {
    expect(passwordProblems('a decent long phrase')).toEqual([]);
  });
});

describe('lockout climbs rather than slams', () => {
  it('costs nothing for the first four attempts', () => {
    for (const n of [1, 2, 3, 4]) expect(lockoutMinutes(n)).toBeNull();
  });

  it('starts at a minute', () => {
    expect(lockoutMinutes(5)).toBe(1);
    expect(lockoutMinutes(6)).toBe(1);
  });

  it('climbs, then caps rather than locking forever', () => {
    expect(lockoutMinutes(7)).toBe(5);
    expect(lockoutMinutes(10)).toBe(15);
    expect(lockoutMinutes(500)).toBe(15);
  });
});

describe('applying a failed attempt', () => {
  const now = '2026-08-09 14:00';

  it('counts up without locking early', () => {
    expect(afterFailure({ failed_logins: 0 }, now)).toEqual({ failedLogins: 1, lockedUntil: null });
  });

  it('locks on the fifth', () => {
    expect(afterFailure({ failed_logins: 4 }, now)).toEqual({
      failedLogins: 5,
      lockedUntil: '2026-08-09 14:01',
    });
  });

  it('extends to the longer window as failures mount', () => {
    expect(afterFailure({ failed_logins: 9 }, now).lockedUntil).toBe('2026-08-09 14:15');
  });

  it('never shortens a lock that is already running', () => {
    const state = { failed_logins: 1, locked_until: '2026-08-09 14:30' };
    expect(afterFailure(state, now).lockedUntil).toBe('2026-08-09 14:30');
  });

  it('reports a lock as live only while it is', () => {
    const state = { locked_until: '2026-08-09 14:05' };
    expect(isLocked(state, '2026-08-09 14:00')).toBe(true);
    expect(isLocked(state, '2026-08-09 14:05')).toBe(false);
    expect(isLocked(state, '2026-08-09 14:06')).toBe(false);
    expect(isLocked({}, now)).toBe(false);
  });

  it('says how long is left, rounded up so it is never an understatement', () => {
    expect(minutesRemaining({ locked_until: '2026-08-09 14:05' }, '2026-08-09 14:00')).toBe(5);
    expect(minutesRemaining({ locked_until: '2026-08-09 14:05' }, '2026-08-09 14:05')).toBe(0);
    expect(minutesRemaining({}, now)).toBe(0);
  });

  it('counts across midnight', () => {
    expect(minutesRemaining({ locked_until: '2026-08-10 00:10' }, '2026-08-09 23:55')).toBe(15);
  });
});
