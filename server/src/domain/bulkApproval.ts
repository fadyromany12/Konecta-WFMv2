/**
 * What a bulk approval is allowed to touch.
 *
 * Approving forty timecards with one click is only defensible if the forty are
 * the ones nobody needed to read. This is the test that decides that, and it
 * lives here rather than in the route because it is a policy about payroll, not
 * a detail of HTTP — and because a rule this consequential should be testable
 * without standing up a server.
 *
 * The bias is deliberately towards refusing. A card wrongly left for a human is
 * five seconds of someone's time; a card wrongly swept into an approved payroll
 * run is a person paid the wrong amount, discovered a fortnight later, and
 * corrected through the post-payroll process.
 */

import type { DateStr } from './time.js';

export interface BulkApprovalCandidate {
  /** The shift has not finished; the card is still being built from punches. */
  inProgress: boolean;
  /** Validation found something that makes the card internally inconsistent. */
  hasErrors: boolean;
  /** No clock off punch — the end time was assumed from the schedule. */
  assumedOff: boolean;
  /** Exception codes carried by the card: LT, LE, LLU, ABS, NCS and so on. */
  exceptions: string[];
  /** The date payroll has already been run up to, if it has. */
  protectDate: DateStr | null;
  payrollDate: DateStr;
}

/**
 * Why this card must not be swept up in a bulk approval, or `null` if it may
 * be. Returning the reason rather than a boolean is what lets the screen tell a
 * supervisor which cards it left behind and why.
 */
export function uncleanReason(row: BulkApprovalCandidate, today: DateStr): string | null {
  if (row.inProgress) return 'the shift is still running';
  if (row.hasErrors) return 'the card has validation errors';
  if (row.assumedOff) return 'no clock off punch — the end was assumed';
  if (row.exceptions.length > 0) return `carries ${row.exceptions.join(', ')}`;
  // Past the protect date a change is a post-payroll correction, which is
  // never something to do without meaning to.
  if (row.protectDate && row.payrollDate <= row.protectDate) {
    return 'payroll has already run for this date';
  }
  // Today's card can still gain time. Approving it says the day is finished
  // when it is not.
  if (row.payrollDate >= today) return 'the day is not finished';
  return null;
}

export function isCleanForBulkApproval(row: BulkApprovalCandidate, today: DateStr): boolean {
  return uncleanReason(row, today) === null;
}
