/**
 * Timecard model: validation, contiguous-row merging, and the payroll summary.
 *
 * The rules encoded here are the ones a supervisor is told to check by hand
 * after every edit — no gaps, no overlaps, the payroll shift detail agreeing
 * with the first and last paid rows, the start date matching the payroll date.
 * Checking them in code is the whole point of the tool: a time-shifted timecard
 * caused by a careless edit is expensive and nearly invisible on screen.
 */

import { ACTIVITY_MAP, CODE_MAP } from './reference.js';
import { checkCodeActivityPairing } from './editWindow.js';
import {
  type DateStr,
  type Stamp,
  dateOf,
  diffMinutes,
  formatDuration,
  toMinutes,
} from './time.js';

export interface TimecardRow {
  id?: number;
  code: string;
  /** Activity ID of the project the time is billed to, e.g. `A123`. */
  project: string;
  activity: string;
  startAt: Stamp;
  endAt: Stamp;
}

export interface Issue {
  level: 'error' | 'warning';
  message: string;
  rowIndex?: number;
}

export interface PayrollShiftDetail {
  startAt: Stamp | null;
  endAt: Stamp | null;
  startDate: DateStr | null;
  endDate: DateStr | null;
  /** True when the shift runs past midnight, so the end date is a day later. */
  crossesMidnight: boolean;
}

export interface TimecardSummary {
  regularMinutes: number;
  overtimeMinutes: number;
  paidTimeOffMinutes: number;
  absenceMinutes: number;
  unpaidMealMinutes: number;
  extraHoursMinutes: number;
  totalPaidMinutes: number;
  /** Distinct codes on the card, sorted — the Code column of the payroll summary. */
  codes: string[];
  formatted: Record<string, string>;
}

const ABSENCE_CODES = new Set(['LT', 'LE', 'ABS', 'NCS', 'MAA', 'LLU', 'LB', 'UTO']);
const PAID_TIME_OFF_CODES = new Set(['PTO', 'SCK']);

export function rowMinutes(row: TimecardRow): number {
  return diffMinutes(row.startAt, row.endAt);
}

/** A row pays out only when both its code and its activity are paid. */
export function isRowPaid(row: TimecardRow): boolean {
  const code = CODE_MAP.get(row.code);
  const activity = ACTIVITY_MAP.get(row.activity);
  return !!code?.paid && !!activity?.paid;
}

export function sortRows(rows: TimecardRow[]): TimecardRow[] {
  return [...rows].sort((a, b) => toMinutes(a.startAt) - toMinutes(b.startAt));
}

/**
 * Validate a full card. Errors block the save; warnings are surfaced but the
 * supervisor may still have a legitimate reason to proceed.
 */
export function validateTimecard(rows: TimecardRow[], payrollDate: DateStr): Issue[] {
  const issues: Issue[] = [];
  if (rows.length === 0) return issues;

  const sorted = sortRows(rows);

  for (const [i, row] of sorted.entries()) {
    if (!CODE_MAP.has(row.code)) {
      issues.push({ level: 'error', rowIndex: i, message: `Row ${i + 1}: unknown code ${row.code}.` });
    }
    if (row.activity && !ACTIVITY_MAP.has(row.activity)) {
      issues.push({ level: 'error', rowIndex: i, message: `Row ${i + 1}: unknown activity ${row.activity}.` });
    }
    if (!row.project) {
      issues.push({ level: 'warning', rowIndex: i, message: `Row ${i + 1}: no project assigned; time will not roll up to a project.` });
    }
    const mins = rowMinutes(row);
    if (mins < 0) {
      issues.push({
        level: 'error',
        rowIndex: i,
        message: `Row ${i + 1}: end time ${row.endAt} is before start time ${row.startAt}. This is the classic cause of a time-shifted timecard.`,
      });
    } else if (mins === 0) {
      issues.push({ level: 'warning', rowIndex: i, message: `Row ${i + 1}: zero duration.` });
    } else if (mins > 16 * 60) {
      issues.push({
        level: 'warning',
        rowIndex: i,
        message: `Row ${i + 1}: duration of ${formatDuration(mins)} exceeds 16 hours — check the dates on this row.`,
      });
    }
  }

  // Gaps and overlaps between consecutive rows.
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const delta = diffMinutes(prev.endAt, cur.startAt);
    if (delta > 0) {
      issues.push({
        level: 'error',
        rowIndex: i,
        message: `Gap of ${formatDuration(delta)} between ${prev.endAt} and ${cur.startAt}. When you delete or shorten a row you must account for the time removed.`,
      });
    } else if (delta < 0) {
      issues.push({
        level: 'error',
        rowIndex: i,
        message: `Overlap of ${formatDuration(-delta)}: row ${i} ends ${prev.endAt} but row ${i + 1} starts ${cur.startAt}.`,
      });
    }
  }

  for (const problem of checkCodeActivityPairing(sorted)) {
    issues.push({ level: 'error', message: problem });
  }

  const detail = payrollShiftDetail(sorted);
  if (detail.startDate && detail.startDate !== payrollDate) {
    issues.push({
      level: 'error',
      message: `Payroll shift detail starts ${detail.startDate} but the payroll date is ${payrollDate}. All paid time in a shift must be associated with a single payroll date.`,
    });
  }

  return issues;
}

/**
 * Where the paid shift actually begins and ends. Absence-only rows at either
 * edge (a Late at the front, a Leave Early at the back) are excluded: those
 * represent scheduled time that was not worked, so they must not stretch the
 * paid window.
 */
export function payrollShiftDetail(rows: TimecardRow[]): PayrollShiftDetail {
  const sorted = sortRows(rows);
  const paid = sorted.filter(isRowPaid);
  if (paid.length === 0) {
    return { startAt: null, endAt: null, startDate: null, endDate: null, crossesMidnight: false };
  }
  const startAt = paid[0].startAt;
  const endAt = paid[paid.length - 1].endAt;
  return {
    startAt,
    endAt,
    startDate: dateOf(startAt),
    endDate: dateOf(endAt),
    crossesMidnight: dateOf(startAt) !== dateOf(endAt),
  };
}

/**
 * Merge contiguous rows that share a code, project and activity. This is
 * deliberate behaviour, not a tidy-up: after correcting a Long Lunch back to
 * worked phone time the corrected row disappears into its neighbours, and a
 * supervisor who does not expect that will think their edit was lost.
 */
export function mergeContiguous(rows: TimecardRow[]): TimecardRow[] {
  const sorted = sortRows(rows);
  const out: TimecardRow[] = [];
  for (const row of sorted) {
    const last = out[out.length - 1];
    if (
      last &&
      last.code === row.code &&
      last.project === row.project &&
      last.activity === row.activity &&
      last.endAt === row.startAt
    ) {
      out[out.length - 1] = { ...last, endAt: row.endAt };
    } else {
      out.push({ ...row });
    }
  }
  return out;
}

export function summarize(rows: TimecardRow[]): TimecardSummary {
  let regular = 0;
  let overtime = 0;
  let paidTimeOff = 0;
  let absence = 0;
  let unpaidMeal = 0;
  let extraHours = 0;

  for (const row of rows) {
    const mins = Math.max(0, rowMinutes(row));
    const code = row.code;
    if (code === 'OT') {
      overtime += mins;
    } else if (PAID_TIME_OFF_CODES.has(code)) {
      paidTimeOff += mins;
    } else if (ABSENCE_CODES.has(code)) {
      absence += mins;
    } else if (code === 'LUN') {
      unpaidMeal += mins;
    } else if (isRowPaid(row)) {
      regular += mins;
      // Extra hours are reported separately but are still regular, not overtime.
      if (code === 'EXH') extraHours += mins;
    }
  }

  const codes = [...new Set(rows.map((r) => r.code))].sort();
  const totalPaid = regular + overtime + paidTimeOff;

  return {
    regularMinutes: regular,
    overtimeMinutes: overtime,
    paidTimeOffMinutes: paidTimeOff,
    absenceMinutes: absence,
    unpaidMealMinutes: unpaidMeal,
    extraHoursMinutes: extraHours,
    totalPaidMinutes: totalPaid,
    codes,
    formatted: {
      regular: formatDuration(regular),
      overtime: formatDuration(overtime),
      paidTimeOff: formatDuration(paidTimeOff),
      absence: formatDuration(absence),
      unpaidMeal: formatDuration(unpaidMeal),
      extraHours: formatDuration(extraHours),
      totalPaid: formatDuration(totalPaid),
    },
  };
}

/** Does this card carry a code that a supervisor is expected to look into? */
export function exceptionCodes(rows: TimecardRow[]): string[] {
  return [...new Set(rows.filter((r) => CODE_MAP.get(r.code)?.exception).map((r) => r.code))].sort();
}
