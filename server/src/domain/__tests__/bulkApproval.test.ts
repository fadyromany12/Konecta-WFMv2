import { describe, expect, it } from 'vitest';
import { isCleanForBulkApproval, uncleanReason, type BulkApprovalCandidate } from '../bulkApproval.js';

const TODAY = '2025-06-12';

function card(overrides: Partial<BulkApprovalCandidate> = {}): BulkApprovalCandidate {
  return {
    inProgress: false,
    hasErrors: false,
    assumedOff: false,
    exceptions: [],
    protectDate: null,
    payrollDate: '2025-06-10',
    ...overrides,
  };
}

describe('what a bulk approval may touch', () => {
  it('approves a finished day with nothing on it', () => {
    expect(uncleanReason(card(), TODAY)).toBeNull();
    expect(isCleanForBulkApproval(card(), TODAY)).toBe(true);
  });

  it('refuses a shift that is still running', () => {
    expect(uncleanReason(card({ inProgress: true }), TODAY)).toMatch(/still running/);
  });

  it('refuses a card with validation errors', () => {
    expect(uncleanReason(card({ hasErrors: true }), TODAY)).toMatch(/validation errors/);
  });

  it('refuses a card whose end time was assumed', () => {
    // No clock off punch means the end came from the schedule, not the advisor.
    // That is exactly the guess a human is supposed to check.
    expect(uncleanReason(card({ assumedOff: true }), TODAY)).toMatch(/assumed/);
  });

  it('refuses any card carrying an exception, and names them', () => {
    const reason = uncleanReason(card({ exceptions: ['LT', 'LLU'] }), TODAY);
    expect(reason).toContain('LT');
    expect(reason).toContain('LLU');
  });

  it('refuses a single exception as firmly as several', () => {
    expect(isCleanForBulkApproval(card({ exceptions: ['ABS'] }), TODAY)).toBe(false);
  });

  it('refuses today, because the day can still gain time', () => {
    expect(uncleanReason(card({ payrollDate: TODAY }), TODAY)).toMatch(/not finished/);
  });

  it('refuses a future date', () => {
    expect(isCleanForBulkApproval(card({ payrollDate: '2025-06-20' }), TODAY)).toBe(false);
  });

  it('refuses a date payroll has already run for', () => {
    const reason = uncleanReason(card({ payrollDate: '2025-06-01', protectDate: '2025-06-07' }), TODAY);
    expect(reason).toMatch(/payroll has already run/);
  });

  it('allows a date after the protect date', () => {
    // The protect date exists; this card simply falls the safe side of it.
    expect(isCleanForBulkApproval(card({ payrollDate: '2025-06-10', protectDate: '2025-06-07' }), TODAY)).toBe(
      true,
    );
  });

  it('reports the most fundamental problem first', () => {
    // A card can fail several tests at once. "Still running" explains all the
    // others, so it is the one worth telling the supervisor about.
    const reason = uncleanReason(
      card({ inProgress: true, hasErrors: true, exceptions: ['LT'], assumedOff: true }),
      TODAY,
    );
    expect(reason).toMatch(/still running/);
  });
});
