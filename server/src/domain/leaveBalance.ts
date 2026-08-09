/**
 * What somebody may actually ask for, and what may actually be approved.
 *
 * The original check compared one request against the accrued balance and
 * nothing else, which is correct exactly once. Ask twice and both pass, because
 * neither knows about the other: forty hours of entitlement accepted four
 * separate forty hour requests, and a supervisor approving them all would have
 * put the advisor a hundred and twenty hours negative with no warning at any
 * point.
 *
 * The fix is that a pending request is a claim on the balance even though it has
 * not been deducted yet. Money that is spoken for is not available, and the
 * moment to say so is when it is asked for — telling somebody on approval that
 * three of their four requests were never possible is worse than useless.
 *
 * Two rules, and they refuse rather than warn. Unlike a working-time limit,
 * neither has a legitimate override: an overlapping request is a data
 * contradiction, and leave that exceeds entitlement is an amount that cannot be
 * paid.
 */

import type { DateStr } from './time.js';

export interface LeaveClaim {
  /** PENDING or APPROVED. Anything decided otherwise is not a claim. */
  startDate: DateStr;
  endDate: DateStr;
  accrualType: string;
  hours: number;
  status: string;
}

export interface LeaveVerdict {
  ok: boolean;
  /** Hours left once everything already claimed is taken off. */
  available: number;
  reason?: string;
}

/** A claim is live if it is waiting or already granted. */
export function isLive(claim: { status: string }): boolean {
  return claim.status === 'PENDING' || claim.status === 'APPROVED';
}

const overlaps = (
  a: { startDate: DateStr; endDate: DateStr },
  b: { startDate: DateStr; endDate: DateStr },
): boolean => a.startDate <= b.endDate && b.startDate <= a.endDate;

/**
 * Judge a new request against everything already on file.
 *
 * `balanceHours` is what has accrued. `claims` is every other request for this
 * person — the caller passes them all rather than filtering, because the
 * overlap rule spans types (you cannot be on sick leave and holiday at once)
 * while the balance rule does not.
 *
 * Unpaid leave draws on nothing, so it skips the balance rule and keeps the
 * overlap one.
 */
export function assessRequest(params: {
  accrualType: string;
  startDate: DateStr;
  endDate: DateStr;
  hours: number;
  balanceHours: number;
  claims: LeaveClaim[];
}): LeaveVerdict {
  const { accrualType, startDate, endDate, hours, balanceHours } = params;
  const live = params.claims.filter(isLive);

  if (endDate < startDate) {
    return { ok: false, available: balanceHours, reason: 'The end date is before the start date.' };
  }

  const clash = live.find((claim) => overlaps(claim, { startDate, endDate }));
  if (clash) {
    return {
      ok: false,
      available: balanceHours,
      reason:
        `You ${clash.status === 'APPROVED' ? 'already have approved' : 'have already requested'} ` +
        `${clash.accrualType.toLowerCase().replace(/_/g, ' ')} from ${clash.startDate} to ${clash.endDate}. ` +
        'Cancel that first if you want to change it.',
    };
  }

  if (accrualType === 'UNPAID') return { ok: true, available: balanceHours };

  // Approved requests have already been deducted from the balance; pending ones
  // have not, so only those are subtracted again here. Counting both would
  // charge an approved request twice.
  const spokenFor = live
    .filter((claim) => claim.status === 'PENDING' && claim.accrualType === accrualType)
    .reduce((sum, claim) => sum + claim.hours, 0);

  const available = balanceHours - spokenFor;
  if (hours > available) {
    const what = accrualType.toLowerCase().replace(/_/g, ' ');
    return {
      ok: false,
      available,
      reason:
        spokenFor > 0
          ? `You have ${balanceHours} hours of ${what} accrued, ${spokenFor} already requested and waiting, ` +
            `so ${available} left — and asked for ${hours}.`
          : `You have ${balanceHours} hours of ${what} accrued and asked for ${hours}.`,
    };
  }

  return { ok: true, available };
}

/**
 * Judge a request again at the moment of approval.
 *
 * The balance can have moved since it was raised — another request approved, a
 * correction, a new accrual year — so approving on the strength of the original
 * check would be trusting a number that is no longer true. Only *other*
 * approved leave is counted here: this request is the one being decided, and
 * the ones still pending are not yet a charge on the account.
 */
export function assessApproval(params: {
  accrualType: string;
  hours: number;
  balanceHours: number;
}): LeaveVerdict {
  const { accrualType, hours, balanceHours } = params;
  if (accrualType === 'UNPAID') return { ok: true, available: balanceHours };
  if (hours > balanceHours) {
    return {
      ok: false,
      available: balanceHours,
      reason:
        `Approving this would take them ${Math.round((hours - balanceHours) * 10) / 10} hours below zero — ` +
        `${balanceHours} accrued against a ${hours} hour request. The balance has changed since they asked.`,
    };
  }
  return { ok: true, available: balanceHours };
}
