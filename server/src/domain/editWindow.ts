/**
 * Edit windows and payroll protection.
 *
 * A timecard is a financial document. Two independent gates gate an edit:
 *
 *  1. The role's edit window — how many days back that role may reach at all.
 *  2. The protect date — set when payroll runs over a period. Editing inside a
 *     protected period is still permitted, but it becomes a post-payroll
 *     correction that transfers on a later payroll run rather than the one that
 *     has already gone out.
 */

import { ACTIVITY_MAP, EDIT_WINDOW_DAYS, SUPERVISOR_ROLES, type Role } from './reference.js';
import { diffDays, type DateStr } from './time.js';

export interface EditDecision {
  allowed: boolean;
  /** True when the edit lands inside an already-run payroll period. */
  postPayroll: boolean;
  reason: string;
  /** Oldest payroll date this role can still reach. */
  windowStart: DateStr;
  windowDays: number;
}

export function evaluateEdit(params: {
  role: Role;
  payrollDate: DateStr;
  today: DateStr;
  protectDate?: DateStr | null;
}): EditDecision {
  const { role, payrollDate, today, protectDate } = params;
  const windowDays = EDIT_WINDOW_DAYS[role];
  const age = diffDays(payrollDate, today);
  const windowStart = shiftBack(today, windowDays);
  const postPayroll = !!protectDate && diffDays(payrollDate, protectDate) >= 0;

  // Editing a timecard is a supervisory act. Roles without that authority are
  // refused before any date arithmetic — a zero-day window means "no edit
  // rights", not "today only".
  if (!SUPERVISOR_ROLES.includes(role)) {
    return {
      allowed: false,
      postPayroll,
      reason:
        'Your role cannot edit timecards. Raise the correction with your Team Leader, with a timekeeping correction form if one is required.',
      windowStart,
      windowDays,
    };
  }

  if (age < 0) {
    return {
      allowed: false,
      postPayroll,
      reason: 'Timecards cannot be edited for a future payroll date.',
      windowStart,
      windowDays,
    };
  }

  if (age > windowDays) {
    return {
      allowed: false,
      postPayroll,
      reason: `Outside your ${windowDays}-day edit window (oldest editable payroll date is ${windowStart}). Escalate to your Operations Manager to make this correction.`,
      windowStart,
      windowDays,
    };
  }

  if (postPayroll) {
    return {
      allowed: true,
      postPayroll: true,
      reason:
        'Payroll has already run for this period. Saving creates a post-payroll correction that transfers on the next payroll run.',
      windowStart,
      windowDays,
    };
  }

  return { allowed: true, postPayroll: false, reason: 'Within edit window.', windowStart, windowDays };
}

function shiftBack(date: DateStr, days: number): DateStr {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Guard for the trap the training calls out explicitly: changing a Long Lunch
 * row's code to Worked without also changing the activity off the unpaid meal
 * code leaves the advisor unpaid for time you just told them they would be paid
 * for. The pairing is invisible on screen, so we check it on save.
 */
export function checkCodeActivityPairing(rows: { code: string; activity: string }[]): string[] {
  const problems: string[] = [];
  for (const [i, row] of rows.entries()) {
    const activity = ACTIVITY_MAP.get(row.activity);
    if (!activity) continue;
    const paidCode = ['(W)', 'BRK', 'EXH', 'FLXU', 'FLXD', 'OT', 'PTO', 'SCK'].includes(row.code);
    if (paidCode && !activity.paid) {
      problems.push(
        `Row ${i + 1}: code ${row.code} is paid but activity ${row.activity} (${activity.name}) is not. ` +
          'Change the activity as well, or the advisor will not be paid for this time.',
      );
    }
    if (row.code === 'LUN' && activity.paid) {
      problems.push(
        `Row ${i + 1}: Lunch is unpaid but activity ${row.activity} (${activity.name}) is a paid activity.`,
      );
    }
  }
  return problems;
}
