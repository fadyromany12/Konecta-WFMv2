import { describe, expect, it } from 'vitest';
import { checkCodeActivityPairing, evaluateEdit } from '../editWindow.js';

const TODAY = '2026-03-15';

describe('edit windows', () => {
  it('lets a Team Leader reach back three days but no further', () => {
    expect(evaluateEdit({ role: 'TEAM_LEADER', payrollDate: '2026-03-12', today: TODAY }).allowed).toBe(true);
    expect(evaluateEdit({ role: 'TEAM_LEADER', payrollDate: '2026-03-11', today: TODAY }).allowed).toBe(false);
  });

  it('tells a Team Leader to escalate rather than just refusing', () => {
    const decision = evaluateEdit({ role: 'TEAM_LEADER', payrollDate: '2026-03-01', today: TODAY });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Operations Manager');
    expect(decision.windowStart).toBe('2026-03-12');
  });

  it('gives a Trainer six days, for new hires not yet in the system', () => {
    expect(evaluateEdit({ role: 'TRAINER', payrollDate: '2026-03-09', today: TODAY }).allowed).toBe(true);
    expect(evaluateEdit({ role: 'TRAINER', payrollDate: '2026-03-08', today: TODAY }).allowed).toBe(false);
  });

  it('gives an Operations Manager 44 days', () => {
    expect(evaluateEdit({ role: 'OPS_MANAGER', payrollDate: '2026-01-31', today: TODAY }).allowed).toBe(true);
    expect(evaluateEdit({ role: 'OPS_MANAGER', payrollDate: '2026-01-29', today: TODAY }).allowed).toBe(false);
  });

  it('does not let an advisor edit their own timecard', () => {
    expect(evaluateEdit({ role: 'ADVISOR', payrollDate: TODAY, today: TODAY }).allowed).toBe(false);
  });

  it('refuses a future payroll date outright', () => {
    const decision = evaluateEdit({ role: 'OPS_MANAGER', payrollDate: '2026-03-16', today: TODAY });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('future');
  });

  it('allows an edit inside a run payroll period but marks it a correction', () => {
    const decision = evaluateEdit({
      role: 'TEAM_LEADER',
      payrollDate: '2026-03-13',
      today: TODAY,
      protectDate: '2026-03-14',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.postPayroll).toBe(true);
    expect(decision.reason).toContain('post-payroll correction');
  });

  it('does not flag a correction when the protect date predates the card', () => {
    const decision = evaluateEdit({
      role: 'TEAM_LEADER',
      payrollDate: '2026-03-14',
      today: TODAY,
      protectDate: '2026-03-13',
    });
    expect(decision.postPayroll).toBe(false);
  });
});

describe('code and activity pairing', () => {
  it('catches a paid code left on the unpaid meal activity', () => {
    // Correcting a Long Lunch to Worked without also moving off 99-001 leaves
    // the advisor unpaid for time they were told they would be paid for.
    const problems = checkCodeActivityPairing([{ code: '(W)', activity: '99-001' }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('will not be paid');
  });

  it('accepts the corrected pairing', () => {
    expect(checkCodeActivityPairing([{ code: '(W)', activity: '01-001' }])).toHaveLength(0);
  });

  it('catches a Lunch code sitting on a paid activity', () => {
    expect(checkCodeActivityPairing([{ code: 'LUN', activity: '01-001' }])).toHaveLength(1);
  });
});
