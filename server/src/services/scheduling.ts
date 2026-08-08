/**
 * Schedule persistence. Shifts are stored as ordered rows plus an end marker;
 * everything else (segment ends, durations, dates) is derived on read so the
 * stored form has exactly one representation of the truth.
 */

import { audit, db, placeholders, transact } from '../db/index.js';
import type { ScheduleActivityKey } from '../domain/reference.js';
import { resolveRowDates, shiftSpan, validateSchedule, type ScheduleShift } from '../domain/schedule.js';
import { addDays, nowStamp, resolveAfter, timeOf, toMinutes, type DateStr, type Stamp } from '../domain/time.js';
import type { Issue } from '../domain/timecard.js';

interface ScheduleRecord {
  id: number;
  user_id: number;
  payroll_date: string;
  shift_no: number;
  end_at: string;
  source: string;
}

export async function getShifts(userId: number, date: DateStr): Promise<ScheduleShift[]> {
  const records = await db.all<ScheduleRecord>(
    'SELECT * FROM schedules WHERE user_id = ? AND payroll_date = ? ORDER BY shift_no',
    [userId, date],
  );
  if (records.length === 0) return [];

  // One query for every row across every shift of the day rather than one per
  // shift. Over a network the difference between one round trip and three is
  // the difference between a screen that feels instant and one that does not.
  const rows = await db.all<{ id: number; schedule_id: number; start_at: string; activity_key: string }>(
    `SELECT id, schedule_id, start_at, activity_key FROM schedule_rows
     WHERE schedule_id IN (${placeholders(records.length)}) ORDER BY schedule_id, sort_order`,
    records.map((r) => r.id),
  );

  return records.map((record) => ({
    shiftNo: record.shift_no,
    endAt: record.end_at,
    rows: rows
      .filter((r) => r.schedule_id === record.id)
      .map((r) => ({
        id: r.id,
        startAt: r.start_at,
        activityKey: r.activity_key as ScheduleActivityKey,
      })),
  }));
}

/**
 * Shifts for many people across many dates, in two queries rather than two per
 * person per date.
 *
 * The live board asks for every advisor's shifts for today and yesterday, and
 * the coverage chart asks the same for a whole roster. Done one at a time that
 * is sixty round trips to draw one screen — imperceptible against a local file
 * and ruinous against a database over a network. Keyed `userId|date`.
 */
export async function getShiftsFor(
  userIds: number[],
  dates: DateStr[],
): Promise<Map<string, ScheduleShift[]>> {
  const out = new Map<string, ScheduleShift[]>();
  if (userIds.length === 0 || dates.length === 0) return out;

  const records = await db.all<ScheduleRecord>(
    `SELECT * FROM schedules
     WHERE user_id IN (${placeholders(userIds.length)})
       AND payroll_date IN (${placeholders(dates.length)})
     ORDER BY user_id, payroll_date, shift_no`,
    [...userIds, ...dates],
  );
  if (records.length === 0) return out;

  const rows = await db.all<{ id: number; schedule_id: number; start_at: string; activity_key: string }>(
    `SELECT id, schedule_id, start_at, activity_key FROM schedule_rows
     WHERE schedule_id IN (${placeholders(records.length)}) ORDER BY schedule_id, sort_order`,
    records.map((r) => r.id),
  );

  const rowsBySchedule = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = rowsBySchedule.get(row.schedule_id);
    if (list) list.push(row);
    else rowsBySchedule.set(row.schedule_id, [row]);
  }

  for (const record of records) {
    const key = `${record.user_id}|${record.payroll_date}`;
    const shift: ScheduleShift = {
      shiftNo: record.shift_no,
      endAt: record.end_at,
      rows: (rowsBySchedule.get(record.id) ?? []).map((r) => ({
        id: r.id,
        startAt: r.start_at,
        activityKey: r.activity_key as ScheduleActivityKey,
      })),
    };
    const existing = out.get(key);
    if (existing) existing.push(shift);
    else out.set(key, [shift]);
  }
  return out;
}

export async function getShiftsInRange(userId: number, start: DateStr, end: DateStr) {
  const rows = await db.all<{ payroll_date: string }>(
    'SELECT DISTINCT payroll_date FROM schedules WHERE user_id = ? AND payroll_date BETWEEN ? AND ? ORDER BY payroll_date',
    [userId, start, end],
  );
  const days = [];
  for (const { payroll_date: date } of rows) {
    days.push({ date, shifts: await getShifts(userId, date) });
  }
  return days;
}

export interface SaveResult {
  ok: boolean;
  issues: Issue[];
  shifts: ScheduleShift[];
}

export async function saveShifts(params: {
  userId: number;
  date: DateStr;
  shifts: ScheduleShift[];
  actorId: number;
  source?: string;
}): Promise<SaveResult> {
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

  await transact(async () => {
    await db.run('DELETE FROM schedules WHERE user_id = ? AND payroll_date = ?', [userId, date]);
    for (const shift of shifts) {
      const scheduleId = await db.insert(
        'INSERT INTO schedules (user_id, payroll_date, shift_no, end_at, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, date, shift.shiftNo, shift.endAt, source, nowStamp()],
      );
      for (const [i, row] of shift.rows.entries()) {
        await db.run(
          'INSERT INTO schedule_rows (schedule_id, start_at, activity_key, sort_order) VALUES (?, ?, ?, ?)',
          [scheduleId, row.startAt, row.activityKey, i],
        );
      }
    }
    await audit(actorId, 'schedule', `${userId}:${date}`, 'SAVE', {
      shifts: shifts.map((s) => ({ shiftNo: s.shiftNo, rows: s.rows.length, endAt: s.endAt })),
    });
  });

  return { ok: true, issues, shifts: await getShifts(userId, date) };
}

/**
 * Apply one exception to a whole group at once — the intraday gesture for a
 * team meeting or a focus group that lands on everybody's schedule together.
 */
export async function applyGroupException(params: {
  userIds: number[];
  date: DateStr;
  activityKey: ScheduleActivityKey;
  startTime: string;
  endTime: string;
  actorId: number;
}): Promise<{ applied: number[]; skipped: { userId: number; reason: string }[] }> {
  const applied: number[] = [];
  const skipped: { userId: number; reason: string }[] = [];

  for (const userId of params.userIds) {
    const shifts = await getShifts(userId, params.date);
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

    const result = await saveShifts({
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
