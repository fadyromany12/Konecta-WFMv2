/**
 * Punch engine — turns raw clock punches plus a schedule into a timecard.
 *
 * This is the "start of day" process: it is what produces Late, Leave Early,
 * Long Lunch, Absence and No Call No Show codes, so that a supervisor reviews
 * exceptions rather than reconstructing a shift by hand. Everything it emits is
 * editable afterwards; the engine only ever proposes the first draft.
 */

import { ACTIVITY_MAP, type ShiftRule } from './reference.js';
import { toSegments, type ScheduleShift, shiftSpan } from './schedule.js';
import type { TimecardRow } from './timecard.js';
import { mergeContiguous, sortRows } from './timecard.js';
import { type Stamp, diffMinutes, toMinutes } from './time.js';

export type PunchType = 'ON' | 'OFF' | 'CHANGE';

export interface Punch {
  at: Stamp;
  type: PunchType;
  /** Activity being punched into. Absent for a clock-off. */
  activity?: string | null;
}

export interface BuildResult {
  rows: TimecardRow[];
  /** True when the advisor never clocked off and we assumed the scheduled end. */
  assumedOff: boolean;
  /** True when the shift is still running, so the card is provisional. */
  inProgress: boolean;
  notes: string[];
}

export function buildTimecard(params: {
  shifts: ScheduleShift[];
  punches: Punch[];
  rule: ShiftRule;
  project: string;
  now: Stamp;
}): BuildResult {
  const { shifts, punches, rule, project, now } = params;
  const notes: string[] = [];
  const rows: TimecardRow[] = [];

  const ordered = [...punches].sort((a, b) => toMinutes(a.at) - toMinutes(b.at));
  const span = shifts.length > 0 ? shiftSpan(shifts[0]) : null;
  const allSpans = shifts.map(shiftSpan);
  const schedStart = span?.startAt ?? null;
  const schedEnd =
    allSpans.length > 0
      ? allSpans.reduce((a, b) => (toMinutes(a.endAt) >= toMinutes(b.endAt) ? a : b)).endAt
      : null;

  // No punches at all against a real schedule.
  if (ordered.length === 0) {
    if (schedStart && schedEnd) {
      const shiftIsOver = toMinutes(now) > toMinutes(schedEnd);
      if (shiftIsOver) {
        rows.push({ code: 'NCS', project, activity: '99-003', startAt: schedStart, endAt: schedEnd });
        notes.push('No punches recorded for a scheduled shift — raised as No Call No Show pending review.');
      }
      return { rows, assumedOff: false, inProgress: !shiftIsOver, notes };
    }
    return { rows, assumedOff: false, inProgress: false, notes };
  }

  const firstOn = ordered.find((p) => p.type === 'ON') ?? ordered[0];
  const lastOff = [...ordered].reverse().find((p) => p.type === 'OFF') ?? null;

  // Late: clocked on after the scheduled start by more than the rule's grace.
  if (schedStart && diffMinutes(schedStart, firstOn.at) > rule.lateGraceMinutes) {
    rows.push({ code: 'LT', project, activity: '99-003', startAt: schedStart, endAt: firstOn.at });
    notes.push(
      `Clocked on ${diffMinutes(schedStart, firstOn.at)} minutes after the scheduled start of ${schedStart}.`,
    );
  }

  // Walk the punch stream. Each ON/CHANGE opens a row that the next punch closes.
  const working = ordered.filter((p) => p.type !== 'OFF');
  let inProgress = false;
  for (const [i, punch] of working.entries()) {
    const next = working[i + 1];
    let endAt: Stamp;
    if (next) {
      endAt = next.at;
    } else if (lastOff && toMinutes(lastOff.at) >= toMinutes(punch.at)) {
      endAt = lastOff.at;
    } else if (schedEnd && toMinutes(now) > toMinutes(schedEnd)) {
      endAt = schedEnd; // assumed off at the scheduled end
    } else {
      endAt = now;
      inProgress = true;
    }
    if (toMinutes(endAt) <= toMinutes(punch.at)) continue;

    const activity = punch.activity ?? '01-001';
    const meta = ACTIVITY_MAP.get(activity);
    const code = meta?.defaultCode ?? '(W)';
    rows.push({ code, project, activity, startAt: punch.at, endAt });
  }

  const assumedOff = !lastOff && !inProgress && !!schedEnd;
  if (assumedOff) {
    notes.push(
      `No clock off punch. The shift end of ${schedEnd} has been assumed — verify the final row before approving.`,
    );
  }

  // Leave Early: clocked off before the scheduled end by more than the grace.
  const actualEnd = lastOff?.at ?? null;
  if (schedEnd && actualEnd && diffMinutes(actualEnd, schedEnd) > rule.earlyGraceMinutes) {
    rows.push({ code: 'LE', project, activity: '99-003', startAt: actualEnd, endAt: schedEnd });
    notes.push(`Clocked off ${diffMinutes(actualEnd, schedEnd)} minutes before the scheduled end of ${schedEnd}.`);
  }

  const withMeals = splitOverruns(rows, rule, project, shifts);
  return { rows: mergeContiguous(withMeals), assumedOff, inProgress, notes };
}

/**
 * Split a meal or break that ran past its allowance into the allowed portion
 * plus an overrun row coded LLU / LB. Keeping the overrun as its own row is
 * what lets a supervisor correct just the excess — for instance turning ten
 * minutes of Long Lunch back into phone time when the advisor was actually
 * working but forgot to punch back in.
 */
function splitOverruns(
  rows: TimecardRow[],
  rule: ShiftRule,
  project: string,
  shifts: ScheduleShift[],
): TimecardRow[] {
  const scheduledBreakMinutes = new Map<string, number>();
  for (const shift of shifts) {
    for (const seg of toSegments(shift)) {
      if (seg.activityKey === 'BREAK') {
        scheduledBreakMinutes.set('26-001', Math.max(scheduledBreakMinutes.get('26-001') ?? 0, seg.minutes));
      }
    }
  }

  const out: TimecardRow[] = [];
  for (const row of sortRows(rows)) {
    const allowance =
      row.activity === '99-001'
        ? rule.lunchMinutes
        : row.activity === '26-001'
          ? (scheduledBreakMinutes.get('26-001') ?? 15)
          : null;

    const mins = diffMinutes(row.startAt, row.endAt);
    if (allowance === null || mins <= allowance) {
      out.push(row);
      continue;
    }

    const boundary = addMins(row.startAt, allowance);
    out.push({ ...row, endAt: boundary });
    out.push({
      code: row.activity === '99-001' ? 'LLU' : 'LB',
      project,
      activity: row.activity,
      startAt: boundary,
      endAt: row.endAt,
    });
  }
  return out;
}

function addMins(s: Stamp, mins: number): Stamp {
  const total = toMinutes(s) + mins;
  const days = Math.floor(total / 1440);
  const rem = total - days * 1440;
  const date = new Date(days * 86400000).toISOString().slice(0, 10);
  return `${date} ${String(Math.floor(rem / 60)).padStart(2, '0')}:${String(rem % 60).padStart(2, '0')}`;
}
