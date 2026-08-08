/**
 * Schedule model.
 *
 * A day's schedule for one advisor is a list of shifts; a shift is a list of
 * rows, each row being a start time plus a schedule activity, terminated by an
 * end-of-shift marker. A row's end is simply the next row's start, which is why
 * inserting a row above another is the natural editing gesture rather than
 * typing two timestamps.
 *
 * Rows are entered as bare `HH:MM`. `resolveRowDates` walks the shift in order
 * and rolls the date forward whenever a time goes backwards, so an overnight
 * shift dates itself correctly without the user thinking about midnight.
 */

import { SCHEDULE_ACTIVITY_MAP, type ScheduleActivityKey } from './reference.js';
import {
  type DateStr,
  type Stamp,
  type TimeStr,
  addDays,
  dateOf,
  diffMinutes,
  formatDuration,
  resolveAfter,
  stamp,
  timeOf,
  toMinutes,
} from './time.js';
import type { Issue } from './timecard.js';

export interface ScheduleRow {
  id?: number;
  startAt: Stamp;
  activityKey: ScheduleActivityKey;
}

export interface ScheduleShift {
  shiftNo: number;
  rows: ScheduleRow[];
  /** End-of-shift marker: the end of the final row. */
  endAt: Stamp;
}

export interface ScheduleSegment {
  activityKey: ScheduleActivityKey;
  activityName: string;
  activity: string;
  startAt: Stamp;
  endAt: Stamp;
  minutes: number;
}

/**
 * Rebuild every row's date from the shift's first row, incrementing whenever
 * the clock goes backwards. Callers pass rows whose *times* are authoritative
 * and whose dates may be stale after an edit.
 */
export function resolveRowDates(shift: ScheduleShift): ScheduleShift {
  if (shift.rows.length === 0) return shift;
  const rows: ScheduleRow[] = [];
  let cursor = shift.rows[0].startAt;
  rows.push({ ...shift.rows[0], startAt: cursor });
  for (const row of shift.rows.slice(1)) {
    cursor = resolveAfter(cursor, timeOf(row.startAt));
    rows.push({ ...row, startAt: cursor });
  }
  const endAt = resolveAfter(cursor, timeOf(shift.endAt));
  return { ...shift, rows, endAt };
}

export function toSegments(shift: ScheduleShift): ScheduleSegment[] {
  const resolved = resolveRowDates(shift);
  return resolved.rows.map((row, i) => {
    const endAt = i + 1 < resolved.rows.length ? resolved.rows[i + 1].startAt : resolved.endAt;
    const meta = SCHEDULE_ACTIVITY_MAP.get(row.activityKey);
    return {
      activityKey: row.activityKey,
      activityName: meta?.name ?? row.activityKey,
      activity: meta?.activity ?? '',
      startAt: row.startAt,
      endAt,
      minutes: diffMinutes(row.startAt, endAt),
    };
  });
}

export function shiftSpan(shift: ScheduleShift): { startAt: Stamp; endAt: Stamp; minutes: number } {
  const resolved = resolveRowDates(shift);
  const startAt = resolved.rows[0]?.startAt ?? resolved.endAt;
  return { startAt, endAt: resolved.endAt, minutes: diffMinutes(startAt, resolved.endAt) };
}

export function validateSchedule(shifts: ScheduleShift[], payrollDate: DateStr): Issue[] {
  const issues: Issue[] = [];

  for (const shift of shifts) {
    if (shift.rows.length === 0) {
      issues.push({ level: 'error', message: `Shift ${shift.shiftNo} has no rows.` });
      continue;
    }
    const resolved = resolveRowDates(shift);
    const span = shiftSpan(resolved);

    if (span.minutes <= 0) {
      issues.push({ level: 'error', message: `Shift ${shift.shiftNo} ends at or before it starts.` });
    }
    if (span.minutes > 16 * 60) {
      issues.push({
        level: 'warning',
        message: `Shift ${shift.shiftNo} spans ${formatDuration(span.minutes)}. Check the times — a row typed out of order rolls the date forward.`,
      });
    }

    for (const [i, seg] of toSegments(resolved).entries()) {
      if (seg.minutes <= 0) {
        issues.push({
          level: 'error',
          rowIndex: i,
          message: `Shift ${shift.shiftNo} row ${i + 1} (${seg.activityName}) has no duration.`,
        });
      }
    }

    // Extra Hours and Flex Up must start on the date the hours actually begin,
    // otherwise the start-of-day process picks up the wrong day and the advisor
    // cannot clock on.
    if (dateOf(span.startAt) !== payrollDate && shift.shiftNo === 1) {
      issues.push({
        level: 'error',
        message: `Shift 1 starts ${dateOf(span.startAt)} but the schedule date is ${payrollDate}. A shift must be entered on the date it starts.`,
      });
    }
  }

  // Shifts on the same day must not overlap each other.
  const spans = shifts.map((s) => ({ no: s.shiftNo, ...shiftSpan(s) })).sort((a, b) => toMinutes(a.startAt) - toMinutes(b.startAt));
  for (let i = 1; i < spans.length; i++) {
    if (toMinutes(spans[i].startAt) < toMinutes(spans[i - 1].endAt)) {
      issues.push({
        level: 'error',
        message: `Shift ${spans[i].no} starts ${spans[i].startAt} before shift ${spans[i - 1].no} ends ${spans[i - 1].endAt}.`,
      });
    }
  }

  return issues;
}

/** Insert a row above `index`, inheriting the date context of its neighbour. */
export function insertRowAbove(
  shift: ScheduleShift,
  index: number,
  activityKey: ScheduleActivityKey,
  time: TimeStr,
): ScheduleShift {
  const anchor = shift.rows[index] ?? shift.rows[shift.rows.length - 1];
  const rows = [...shift.rows];
  rows.splice(index, 0, { startAt: stamp(dateOf(anchor.startAt), time), activityKey });
  return resolveRowDates({ ...shift, rows });
}

export function deleteRow(shift: ScheduleShift, index: number): ScheduleShift {
  const rows = shift.rows.filter((_, i) => i !== index);
  return resolveRowDates({ ...shift, rows });
}

/**
 * Add a second shift to a day, e.g. an Extra Hours block picked up after the
 * advisor has already clocked off their regular shift.
 */
export function addShift(
  shifts: ScheduleShift[],
  payrollDate: DateStr,
  startTime: TimeStr,
  endTime: TimeStr,
  activityKey: ScheduleActivityKey,
): ScheduleShift[] {
  const shiftNo = Math.max(0, ...shifts.map((s) => s.shiftNo)) + 1;
  const startAt = stamp(payrollDate, startTime);
  const endAt = resolveAfter(startAt, endTime);
  return [...shifts, { shiftNo, rows: [{ startAt, activityKey }], endAt }];
}

/** Paid, scheduled minutes — the denominator for adherence. */
export function scheduledPaidMinutes(shifts: ScheduleShift[]): number {
  let total = 0;
  for (const shift of shifts) {
    for (const seg of toSegments(shift)) {
      if (seg.activityKey === 'LUNCH' || seg.activityKey === 'UTO') continue;
      total += Math.max(0, seg.minutes);
    }
  }
  return total;
}

/** The window during which an advisor is permitted to be clocked on. */
export function clockOnWindow(
  shifts: ScheduleShift[],
  leadMinutes: number,
): { earliest: Stamp; latest: Stamp } | null {
  if (shifts.length === 0) return null;
  const spans = shifts.map(shiftSpan);
  const earliestStart = spans.reduce((a, b) => (toMinutes(a.startAt) <= toMinutes(b.startAt) ? a : b));
  const latestEnd = spans.reduce((a, b) => (toMinutes(a.endAt) >= toMinutes(b.endAt) ? a : b));
  return {
    earliest: shiftBackStamp(earliestStart.startAt, leadMinutes),
    latest: shiftForwardStamp(latestEnd.endAt, 120),
  };
}

function shiftBackStamp(s: Stamp, mins: number): Stamp {
  const m = toMinutes(s) - mins;
  return minutesToStamp(m);
}

function shiftForwardStamp(s: Stamp, mins: number): Stamp {
  return minutesToStamp(toMinutes(s) + mins);
}

function minutesToStamp(mins: number): Stamp {
  const days = Math.floor(mins / 1440);
  const rem = mins - days * 1440;
  const date = addDays('1970-01-01', days);
  const hh = String(Math.floor(rem / 60)).padStart(2, '0');
  const mm = String(rem % 60).padStart(2, '0');
  return `${date} ${hh}:${mm}`;
}

/**
 * Which shift a given moment belongs to.
 *
 * The live board looks at two days at once, because a shift that began
 * yesterday evening is still today's business at 02:00. That makes "when was
 * this person due to start?" ambiguous, and getting it wrong is not subtle: the
 * first version took the earliest segment across the whole window, so an
 * advisor who worked yesterday and is due on again today was reported as 1833
 * minutes late — measured against a shift that had finished thirty hours
 * earlier.
 *
 * The moment belongs to the shift that contains it. Failing that, to the next
 * shift due to start on `today`, so a screen can still say when someone is
 * expected. Never to a shift that has already ended.
 */
export function activeShift(
  shifts: ScheduleShift[],
  now: Stamp,
  today: DateStr,
): ScheduleShift | null {
  const spans = shifts
    .map((shift) => ({ shift, span: shiftSpan(shift) }))
    .sort((a, b) => a.span.startAt.localeCompare(b.span.startAt));

  const containing = spans.find((s) => s.span.startAt <= now && s.span.endAt > now);
  if (containing) return containing.shift;

  const upcoming = spans.find((s) => s.span.startAt > now && s.span.startAt.slice(0, 10) === today);
  return upcoming?.shift ?? null;
}
