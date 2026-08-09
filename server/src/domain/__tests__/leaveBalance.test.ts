import { describe, expect, it } from 'vitest';
import { assessApproval, assessRequest, type LeaveClaim } from '../leaveBalance.js';

/**
 * The case that started this: forty hours of entitlement accepted four separate
 * forty hour requests, because each was checked against the balance and none
 * against the others.
 */

const claim = (over: Partial<LeaveClaim> = {}): LeaveClaim => ({
  startDate: '2026-09-01',
  endDate: '2026-09-02',
  accrualType: 'VACATION',
  hours: 16,
  status: 'PENDING',
  ...over,
});

const request = (over: Partial<Parameters<typeof assessRequest>[0]> = {}) =>
  assessRequest({
    accrualType: 'VACATION',
    startDate: '2026-10-01',
    endDate: '2026-10-02',
    hours: 16,
    balanceHours: 40,
    claims: [],
    ...over,
  });

describe('what is actually available', () => {
  it('allows a request that fits the balance', () => {
    expect(request().ok).toBe(true);
    expect(request().available).toBe(40);
  });

  it('refuses a request larger than the balance', () => {
    const verdict = request({ hours: 48 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('40 hours');
  });

  it('counts hours already requested and waiting', () => {
    // The whole bug: 40 accrued, 32 already pending, so only 8 remain.
    const verdict = request({
      hours: 16,
      claims: [claim({ hours: 16 }), claim({ startDate: '2026-09-10', endDate: '2026-09-11', hours: 16 })],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.available).toBe(8);
    expect(verdict.reason).toContain('already requested');
  });

  it('does not charge an approved request twice', () => {
    // Approved leave has already been deducted from the balance, so counting it
    // again here would halve what is really left.
    const verdict = request({
      hours: 40,
      balanceHours: 40,
      claims: [claim({ status: 'APPROVED', hours: 24 })],
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.available).toBe(40);
  });

  it('ignores requests that were declined or cancelled', () => {
    const verdict = request({
      claims: [claim({ status: 'DECLINED', hours: 40 }), claim({ status: 'CANCELLED', hours: 40 })],
    });
    expect(verdict.ok).toBe(true);
  });

  it('lets the balance run exactly to zero', () => {
    expect(request({ hours: 40 }).ok).toBe(true);
    expect(request({ hours: 40.5 }).ok).toBe(false);
  });
});

describe('one day, one absence', () => {
  it('refuses a request that overlaps an existing one', () => {
    const verdict = request({
      startDate: '2026-09-02',
      endDate: '2026-09-03',
      claims: [claim({ startDate: '2026-09-01', endDate: '2026-09-02' })],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('2026-09-01 to 2026-09-02');
  });

  it('refuses an exact duplicate', () => {
    const verdict = request({
      startDate: '2026-09-01',
      endDate: '2026-09-02',
      claims: [claim()],
    });
    expect(verdict.ok).toBe(false);
  });

  it('refuses overlap across different types', () => {
    // You cannot be on sick leave and holiday on the same day.
    const verdict = request({
      accrualType: 'SICK',
      startDate: '2026-09-02',
      endDate: '2026-09-02',
      claims: [claim({ accrualType: 'VACATION' })],
    });
    expect(verdict.ok).toBe(false);
  });

  it('allows adjacent ranges that do not overlap', () => {
    const verdict = request({
      startDate: '2026-09-03',
      endDate: '2026-09-04',
      claims: [claim({ startDate: '2026-09-01', endDate: '2026-09-02' })],
    });
    expect(verdict.ok).toBe(true);
  });

  it('refuses a range that ends before it starts', () => {
    expect(request({ startDate: '2026-10-05', endDate: '2026-10-01' }).ok).toBe(false);
  });
});

describe('unpaid leave', () => {
  it('draws on no balance', () => {
    expect(request({ accrualType: 'UNPAID', hours: 999, balanceHours: 0 }).ok).toBe(true);
  });

  it('still cannot overlap something else', () => {
    const verdict = request({
      accrualType: 'UNPAID',
      startDate: '2026-09-01',
      endDate: '2026-09-01',
      claims: [claim()],
    });
    expect(verdict.ok).toBe(false);
  });
});

describe('checking again at approval', () => {
  it('approves while the balance still covers it', () => {
    expect(assessApproval({ accrualType: 'VACATION', hours: 16, balanceHours: 40 }).ok).toBe(true);
  });

  it('refuses once the balance has moved beneath it', () => {
    // Raised when there was room, approved after something else took it.
    const verdict = assessApproval({ accrualType: 'VACATION', hours: 24, balanceHours: 8 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('16 hours below zero');
  });

  it('never blocks unpaid leave', () => {
    expect(assessApproval({ accrualType: 'UNPAID', hours: 80, balanceHours: 0 }).ok).toBe(true);
  });
});
