/**
 * Schedule persistence. Shifts are stored as ordered rows plus an end marker;
 * everything else (segment ends, durations, dates) is derived on read so the
 * stored form has exactly one representation of the truth.
 */

import { audit, db, placeholders, transact } from '../db/index.js';
import type { ScheduleActivityKey } from '../domain/reference.js';
import {
  resolveRowDates,
  shiftByDays,
  shiftSpan,
  validateSchedule,
  type ScheduleShift,
} from '../domain/schedule.js';
import {
  addDays,
  diffDays,
  nowStamp,
  resolveAfter,
  timeOf,
  toMinutes,
  type DateStr,
  type Stamp,
} from '../domain/time.js';
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

export interface TeamWeekPerson {
  userId: number;
  employeeId: string;
  name: string;
  role: string;
  days: { date: DateStr; shifts: ScheduleShift[] }[];
  /** Scheduled minutes across the range, so a week can be judged at a glance. */
  minutes: number;
}

/**
 * A whole team's week in one read.
 *
 * The day-at-a-time editor answers "what is Layla doing on Thursday" and
 * cannot answer "who is off on Thursday", which is the question a team leader
 * actually opens the tool with. Two queries for the whole grid — see
 * `getShiftsFor` — rather than one per person per day.
 */
export async function teamWeek(params: {
  userIds: number[];
  start: DateStr;
  end: DateStr;
}): Promise<{ start: DateStr; end: DateStr; dates: DateStr[]; people: TeamWeekPerson[] }> {
  const { userIds, start, end } = params;
  const dates: DateStr[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);

  if (userIds.length === 0) return { start, end, dates, people: [] };

  const users = await db.all<{ id: number; employee_id: string; name: string; role: string }>(
    `SELECT id, employee_id, name, role FROM users
     WHERE id IN (${placeholders(userIds.length)}) ORDER BY name`,
    userIds,
  );
  const shiftsByKey = await getShiftsFor(
    users.map((u) => u.id),
    dates,
  );

  const people = users.map((user) => {
    let minutes = 0;
    const days = dates.map((date) => {
      const shifts = shiftsByKey.get(`${user.id}|${date}`) ?? [];
      for (const shift of shifts) minutes += shiftSpan(shift).minutes;
      return { date, shifts };
    });
    return {
      userId: user.id,
      employeeId: user.employee_id,
      name: user.name,
      role: user.role,
      days,
      minutes,
    };
  });

  return { start, end, dates, people };
}

/**
 * Move one shift to another day — what dragging it across the grid means.
 *
 * Every stamp in the shift moves by the same number of days, so an overnight
 * shift stays overnight and a 22:00–06:00 dragged forward a day is still
 * 22:00–06:00 rather than collapsing onto one date.
 *
 * Refused backwards in time. A past day already has punches against it and a
 * derived timecard; silently moving the plan out from under them would rewrite
 * what somebody was measured against after the fact. Correcting the past is a
 * deliberate act and belongs in the day editor, where the edit window applies.
 */
export async function moveShift(params: {
  userId: number;
  fromDate: DateStr;
  toDate: DateStr;
  shiftNo: number;
  today: DateStr;
  actorId: number;
}): Promise<{ ok: boolean; message?: string; issues?: Issue[] }> {
  const { userId, fromDate, toDate, shiftNo, today, actorId } = params;

  if (fromDate === toDate) return { ok: false, message: 'That shift is already on that day.' };
  if (fromDate < today || toDate < today) {
    return {
      ok: false,
      message: 'Schedules move forward only. Use the day editor to correct a day that has already happened.',
    };
  }

  const deltaDays = diffDays(fromDate, toDate);

  return transact(async () => {
    const source = await getShifts(userId, fromDate);
    const moving = source.find((s) => s.shiftNo === shiftNo);
    if (!moving) return { ok: false, message: 'That shift is no longer there — reload and try again.' };

    const shifted = shiftByDays(moving, deltaDays);
    const target = await getShifts(userId, toDate);

    // Sorted by start, not appended. `saveShifts` renumbers by array order and
    // the validator requires shift 1 to finish before shift 2 begins, so an
    // evening shift dropped onto a day that already has a morning one has to
    // land second — otherwise a legal day is refused for being out of order.
    const destinationShifts = [...target, shifted].sort(
      (a, b) => (shiftSpan(a).startAt < shiftSpan(b).startAt ? -1 : 1),
    );

    const destination = await saveShifts({
      userId,
      date: toDate,
      shifts: destinationShifts,
      actorId,
    });
    if (!destination.ok) {
      return {
        ok: false,
        message: `That does not fit on ${toDate}.`,
        issues: destination.issues,
      };
    }

    await saveShifts({
      userId,
      date: fromDate,
      shifts: source.filter((s) => s.shiftNo !== shiftNo),
      actorId,
    });
    return { ok: true };
  });
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

/**
 * Take a group exception back off everybody's schedule.
 *
 * Applying a team meeting to twenty people took one click; removing it took
 * twenty edits, which meant in practice it did not get removed — a meeting that
 * moved stayed on the schedule and quietly counted against everybody's
 * adherence for the rest of the week.
 *
 * Removal is by shape rather than by an identifier, because the exception was
 * never stored as an object: it is rows in a schedule. A row matching the
 * activity and start time is deleted, and the row that resumed the previous
 * activity goes with it — but only when it really is the resume row this
 * inserted, or removing a meeting would swallow whatever the advisor was
 * genuinely scheduled to do next.
 */
export async function removeGroupException(params: {
  userIds: number[];
  date: DateStr;
  activityKey: ScheduleActivityKey;
  startTime: string;
  endTime: string;
  actorId: number;
}): Promise<{ removed: number[]; skipped: { userId: number; reason: string }[] }> {
  const removed: number[] = [];
  const skipped: { userId: number; reason: string }[] = [];

  for (const userId of params.userIds) {
    const shifts = await getShifts(userId, params.date);
    if (shifts.length === 0) {
      skipped.push({ userId, reason: 'No shift scheduled on this date.' });
      continue;
    }

    const shift = shifts[0];
    const index = shift.rows.findIndex(
      (r) => r.activityKey === params.activityKey && timeOf(r.startAt) === params.startTime,
    );
    if (index === -1) {
      skipped.push({ userId, reason: `No ${params.activityKey} at ${params.startTime} on their schedule.` });
      continue;
    }

    const rows = [...shift.rows];
    const resume = rows[index + 1];
    // Drop the resume row only if it starts exactly where the exception ended.
    // Anything else belongs to the advisor's real schedule.
    const dropResume = resume && timeOf(resume.startAt) === params.endTime;
    rows.splice(index, dropResume ? 2 : 1);

    if (rows.length === 0) {
      skipped.push({ userId, reason: 'Removing it would leave an empty shift.' });
      continue;
    }

    const result = await saveShifts({
      userId,
      date: params.date,
      shifts: [{ ...shift, rows }, ...shifts.slice(1)],
      actorId: params.actorId,
    });
    if (result.ok) removed.push(userId);
    else {
      skipped.push({
        userId,
        reason: result.issues.find((i) => i.level === 'error')?.message ?? 'Invalid after removal.',
      });
    }
  }

  return { removed, skipped };
}
