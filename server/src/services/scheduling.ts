/**
 * Schedule persistence. Shifts are stored as ordered rows plus an end marker;
 * everything else (segment ends, durations, dates) is derived on read so the
 * stored form has exactly one representation of the truth.
 */

import { audit, db, transact } from '../db/index.js';
import type { ScheduleActivityKey } from '../domain/reference.js';
import { resolveRowDates, shiftSpan, validateSchedule, type ScheduleShift } from '../domain/schedule.js';
import { addDays, resolveAfter, timeOf, toMinutes, type DateStr, type Stamp } from '../domain/time.js';
import type { Issue } from '../domain/timecard.js';

interface ScheduleRecord {
  id: number;
  user_id: number;
  payroll_date: string;
  shift_no: number;
  end_at: string;
  source: string;
}

export function getShifts(userId: number, date: DateStr): ScheduleShift[] {
  const records = db
    .prepare('SELECT * FROM schedules WHERE user_id = ? AND payroll_date = ? ORDER BY shift_no')
    .all(userId, date) as ScheduleRecord[];

  return records.map((record) => {
    const rows = db
      .prepare('SELECT id, start_at, activity_key FROM schedule_rows WHERE schedule_id = ? ORDER BY sort_order')
      .all(record.id) as { id: number; start_at: string; activity_key: string }[];
    return {
      shiftNo: record.shift_no,
      endAt: record.end_at,
      rows: rows.map((r) => ({
        id: r.id,
        startAt: r.start_at,
        activityKey: r.activity_key as ScheduleActivityKey,
      })),
    };
  });
}

export function getShiftsInRange(userId: number, start: DateStr, end: DateStr) {
  const dates = (
    db
      .prepare(
        'SELECT DISTINCT payroll_date FROM schedules WHERE user_id = ? AND payroll_date BETWEEN ? AND ? ORDER BY payroll_date',
      )
      .all(userId, start, end) as { payroll_date: string }[]
  ).map((r) => r.payroll_date);
  return dates.map((date) => ({ date, shifts: getShifts(userId, date) }));
}

export interface SaveResult {
  ok: boolean;
  issues: Issue[];
  shifts: ScheduleShift[];
}

export function saveShifts(params: {
  userId: number;
  date: DateStr;
  shifts: ScheduleShift[];
  actorId: number;
  source?: string;
}): SaveResult {
  const { userId, date, actorId, source = 'PULSE' } = params;

  // Re-derive dates from times before validating: the client sends the times
  // the user typed, and it is the server's job to decide which day each row
  // lands on.
  const shifts = params.shifts
    .filter((s) => s.rows.length > 0)
    .map((s) => resolveRowDates(s))
    .map((s, i) => ({ ...s, shiftNo: i + 1 }));

  const issues = validateSchedule(shifts, date);
  if (issues.some((i) => i.level === 'error')) {
    return { ok: false, issues, shifts };
  }

  transact(() => {
    db.prepare('DELETE FROM schedules WHERE user_id = ? AND payroll_date = ?').run(userId, date);
    for (const shift of shifts) {
      const info = db
        .prepare(
          'INSERT INTO schedules (user_id, payroll_date, shift_no, end_at, source, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))',
        )
        .run(userId, date, shift.shiftNo, shift.endAt, source);
      const scheduleId = Number(info.lastInsertRowid);
      const insert = db.prepare(
        'INSERT INTO schedule_rows (schedule_id, start_at, activity_key, sort_order) VALUES (?, ?, ?, ?)',
      );
      for (const [i, row] of shift.rows.entries()) {
        insert.run(scheduleId, row.startAt, row.activityKey, i);
      }
    }
    audit(actorId, 'schedule', `${userId}:${date}`, 'SAVE', {
      shifts: shifts.map((s) => ({ shiftNo: s.shiftNo, rows: s.rows.length, endAt: s.endAt })),
    });
  });

  return { ok: true, issues, shifts: getShifts(userId, date) };
}

/**
 * Apply one exception to a whole group at once — the intraday gesture for a
 * team meeting or a focus group that lands on everybody's schedule together.
 */
export function applyGroupException(params: {
  userIds: number[];
  date: DateStr;
  activityKey: ScheduleActivityKey;
  startTime: string;
  endTime: string;
  actorId: number;
}): { applied: number[]; skipped: { userId: number; reason: string }[] } {
  const applied: number[] = [];
  const skipped: { userId: number; reason: string }[] = [];

  for (const userId of params.userIds) {
    const shifts = getShifts(userId, params.date);
    if (shifts.length === 0) {
      skipped.push({ userId, reason: 'No shift scheduled on this date.' });
      continue;
    }

    const shift = shifts[0];
    const span = shiftSpan(shift);

    // A bare time is ambiguous on an overnight shift — 02:00 against a
    // 23:00-07:30 shift means the following morning. Resolve it against the
    // shift's own start rather than the calendar date.
    const startAt = resolveWithin(span.startAt, params.startTime);
    const endAt = resolveAfter(startAt, params.endTime);

    // The exception has to land inside the shift. Anything else would move the
    // shift's start or end, which is never what "add a team meeting" means.
    if (toMinutes(startAt) < toMinutes(span.startAt) || toMinutes(endAt) > toMinutes(span.endAt)) {
      skipped.push({
        userId,
        reason: `${params.startTime}–${params.endTime} falls outside their shift (${timeOf(span.startAt)}–${timeOf(span.endAt)}).`,
      });
      continue;
    }

    const rows = [...shift.rows];
    const index = rows.findIndex((r) => toMinutes(r.startAt) > toMinutes(startAt));
    const insertAt = index === -1 ? rows.length : index;
    // Resume whatever the advisor was scheduled to be doing before the meeting.
    const resumeKey = rows[insertAt - 1]?.activityKey ?? 'OPEN_TIME';
    rows.splice(insertAt, 0, { startAt, activityKey: params.activityKey });
    rows.splice(insertAt + 1, 0, { startAt: endAt, activityKey: resumeKey });

    const result = saveShifts({
      userId,
      date: params.date,
      shifts: [{ ...shift, rows }, ...shifts.slice(1)],
      actorId: params.actorId,
    });
    if (result.ok) applied.push(userId);
    else skipped.push({ userId, reason: result.issues.find((i) => i.level === 'error')?.message ?? 'Invalid' });
  }

  return { applied, skipped };
}

/**
 * Place a bare `HH:MM` on or after a reference instant, rolling to the next day
 * when the time has already passed on the reference's date.
 */
function resolveWithin(reference: Stamp, time: string): Stamp {
  const sameDay = `${reference.slice(0, 10)} ${time}`;
  if (toMinutes(sameDay) >= toMinutes(reference)) return sameDay;
  return `${addDays(reference.slice(0, 10), 1)} ${time}`;
}
