import { describe, expect, it } from 'vitest';
import {
  assignableRoles,
  canAdminister,
  effectiveStatus,
  hasAccess,
  normaliseNewUser,
  temporaryPassword,
  validateNewUser,
  wouldCycle,
  type NewUserInput,
} from '../org.js';

describe('who may administer whom', () => {
  it('lets an administrator create any role', () => {
    expect(canAdminister('ADMIN', 'ADMIN')).toBe(true);
    expect(canAdminister('ADMIN', 'ADVISOR')).toBe(true);
    expect(canAdminister('ADMIN', 'OPS_MANAGER')).toBe(true);
  });

  it('lets an operations manager run their own floor', () => {
    expect(canAdminister('OPS_MANAGER', 'ADVISOR')).toBe(true);
    expect(canAdminister('OPS_MANAGER', 'TEAM_LEADER')).toBe(true);
    expect(canAdminister('OPS_MANAGER', 'TRAINER')).toBe(true);
  });

  it('stops an operations manager minting their own peers or an administrator', () => {
    expect(canAdminister('OPS_MANAGER', 'OPS_MANAGER')).toBe(false);
    expect(canAdminister('OPS_MANAGER', 'ADMIN')).toBe(false);
  });

  it('does not let supervisors administer records at all', () => {
    for (const role of ['TEAM_LEADER', 'TRAINER', 'ADVISOR'] as const) {
      expect(canAdminister(role, 'ADVISOR')).toBe(false);
    }
  });

  it('offers exactly the roles it would allow', () => {
    expect(assignableRoles('OPS_MANAGER')).toEqual(['ADVISOR', 'TEAM_LEADER', 'TRAINER']);
    expect(assignableRoles('TEAM_LEADER')).toEqual([]);
    expect(assignableRoles('ADMIN')).toContain('ADMIN');
  });
});

describe('reporting line cycles', () => {
  //  1 -> 2 -> 3 -> 4   (4 reports to 3, 3 to 2, 2 to 1, 1 to nobody)
  const line = new Map<number, number | null>([
    [1, null],
    [2, 1],
    [3, 2],
    [4, 3],
  ]);

  it('allows an ordinary move', () => {
    expect(wouldCycle(line, 4, 2)).toBe(false);
    expect(wouldCycle(line, 4, null)).toBe(false);
  });

  it('refuses making somebody their own manager', () => {
    expect(wouldCycle(line, 3, 3)).toBe(true);
  });

  it('refuses pointing a manager at their own report', () => {
    expect(wouldCycle(line, 2, 4)).toBe(true);
  });

  it('refuses a longer ring', () => {
    expect(wouldCycle(line, 1, 4)).toBe(true);
  });

  it('terminates on a ring that already exists elsewhere', () => {
    const broken = new Map<number, number | null>([
      [10, 11],
      [11, 10],
      [20, null],
    ]);
    expect(wouldCycle(broken, 20, 10)).toBe(false);
  });
});

describe('a leaver keeps their last day', () => {
  const leaving = { status: 'ACTIVE', leave_date: '2026-08-14' };

  it('still has access on the last working day', () => {
    expect(effectiveStatus(leaving, '2026-08-14')).toBe('ACTIVE');
    expect(hasAccess(leaving, '2026-08-14')).toBe(true);
  });

  it('has access on every day before it', () => {
    expect(hasAccess(leaving, '2026-08-09')).toBe(true);
  });

  it('loses it the following morning, with nobody running anything', () => {
    expect(effectiveStatus(leaving, '2026-08-15')).toBe('TERMINATED');
    expect(hasAccess(leaving, '2026-08-15')).toBe(false);
  });

  it('lets a suspension override a future leave date', () => {
    const suspended = { status: 'SUSPENDED', leave_date: '2026-12-31' };
    expect(effectiveStatus(suspended, '2026-08-09')).toBe('SUSPENDED');
    expect(hasAccess(suspended, '2026-08-09')).toBe(false);
  });

  it('leaves an ordinary record alone', () => {
    expect(effectiveStatus({ status: 'ACTIVE', leave_date: null }, '2026-08-09')).toBe('ACTIVE');
  });

  it('treats an unrecognised stored status as active rather than locking somebody out', () => {
    expect(effectiveStatus({ status: 'WHATEVER' }, '2026-08-09')).toBe('ACTIVE');
  });
});

describe('validating a joiner', () => {
  const good: NewUserInput = {
    employeeId: 'EG-4401',
    name: 'Nour Adel',
    email: 'nour.adel@konecta.example',
    role: 'ADVISOR',
    managerId: 7,
    projectId: 'CAI001',
    departmentCode: '10000',
    shiftRule: 'CR1',
    hireDate: '2026-09-01',
    region: 'EMEA',
  };

  it('accepts a complete record', () => {
    expect(validateNewUser(good)).toEqual([]);
  });

  it('reports every problem at once rather than one per submission', () => {
    const problems = validateNewUser({ employeeId: '', name: 'X', email: 'nope', role: 'ADVISOR' });
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });

  it('insists an advisor has a manager', () => {
    const problems = validateNewUser({ ...good, managerId: null });
    expect(problems).toContain('An advisor needs a manager, or nobody will see them on a roster.');
  });

  it('does not insist a manager has one', () => {
    expect(validateNewUser({ ...good, role: 'OPS_MANAGER', managerId: null })).toEqual([]);
  });

  it('rejects an employee ID with a space in it', () => {
    expect(validateNewUser({ ...good, employeeId: 'EG 4401' }).length).toBe(1);
  });

  it('accepts an address a strict pattern would wrongly refuse', () => {
    expect(validateNewUser({ ...good, email: "o'brien+shift@sub.domain.co.uk" })).toEqual([]);
  });

  it('rejects a malformed hire date', () => {
    expect(validateNewUser({ ...good, hireDate: '01/09/2026' }).length).toBe(1);
  });

  it('lowercases the email and squeezes the name', () => {
    const out = normaliseNewUser({ ...good, email: '  Nour.Adel@Konecta.example ', name: 'Nour   Adel ' });
    expect(out.email).toBe('nour.adel@konecta.example');
    expect(out.name).toBe('Nour Adel');
  });
});

describe('the first password', () => {
  it('is shaped so it can be read down a phone', () => {
    expect(temporaryPassword(() => 0)).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('excludes the characters people mishear', () => {
    let seed = 0;
    const password = temporaryPassword(() => ((seed = (seed + 0.037) % 1), seed));
    expect(password).not.toMatch(/[O0I1]/);
  });

  it('does not return the same thing twice', () => {
    expect(temporaryPassword()).not.toBe(temporaryPassword());
  });
});
