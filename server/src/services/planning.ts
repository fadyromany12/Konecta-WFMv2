/**
 * Planning questions that need more than one part of the system to answer.
 *
 * Everything here reads the roster and the forecast together, which is exactly
 * the join no single screen owned before: the schedule knew who was working,
 * the forecast knew how many were needed, and nobody put the two in front of
 * the person about to make a decision.
 */

import { db, placeholders } from '../db/index.js';
import { INTERVAL_MINUTES } from '../domain/forecast.js';
import { leaveImpact, summariseLeaveImpact, type LeaveImpact } from '../domain/leaveImpact.js';
import { toSegments } from '../domain/schedule.js';
import { addDays, type DateStr } from '../domain/time.js';
import { coverageFor } from './forecasting.js';
import { getShiftsFor } from './scheduling.js';

/** Every date from start to end inclusive. */
function dateRange(start: DateStr, end: DateStr): DateStr[] {
  const out: DateStr[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    out.push(date);
    if (out.length > 90) break; // a request longer than a quarter is a mistake
  }
  return out;
}

/**
 * Which half hours an advisor was actually rostered to answer contacts in.
 *
 * Not "which hours were they at work" — time already scheduled as training, a
 * meeting or a break was never covering the queue, so removing it costs the
 * coverage model nothing and should not be reported as if it did.
 */
function coveringIntervals(segments: ReturnType<typeof toSegments>, date: DateStr): Set<string> {
  const covering = new Set<string>();
  const PRODUCTIVE = ['SHIFT_START', 'OPEN_TIME', 'EXTRA_HOURS', 'FLEX_UP'];

  for (const seg of segments) {
    if (!PRODUCTIVE.includes(seg.activityKey)) continue;
    const start = minutesOfDay(seg.startAt, date);
    const end = minutesOfDay(seg.endAt, date);
    const from = Math.ceil(start / INTERVAL_MINUTES) * INTERVAL_MINUTES;
    for (let m = from; m < end; m += INTERVAL_MINUTES) {
      if (m < 0 || m >= 1440) continue;
      const h = String(Math.floor(m / 60)).padStart(2, '0');
      const min = String(m % 60).padStart(2, '0');
      covering.add(`${h}:${min}`);
    }
  }
  return covering;
}

function minutesOfDay(stamp: string, date: DateStr): number {
  const [h, m] = stamp.slice(11, 16).split(':').map(Number);
  const dayOffset = stamp.slice(0, 10) === date ? 0 : 1440;
  return h * 60 + m + dayOffset;
}

export interface LeaveImpactResult {
  severity: LeaveImpact['severity'];
  summary: string;
  newlyShortIntervals: number;
  days: LeaveImpact[];
  /** False when there is no forecast to compare against. */
  hasForecast: boolean;
}

/**
 * What approving this request would do to coverage, day by day.
 *
 * Advisory only. It reports and never refuses — leave is often approved
 * *because* somebody needs the day whatever the roster says, and a tool that
 * blocked it would be worked around outside the tool, where the roster would
 * not learn about it at all.
 */
export async function assessLeave(params: {
  userId: number;
  start: DateStr;
  end: DateStr;
  /** The team whose coverage is affected. */
  userIds: number[];
  projectId: string | null;
}): Promise<LeaveImpactResult> {
  const dates = dateRange(params.start, params.end);
  const advisor = await db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [params.userId]);

  if (!params.projectId || dates.length === 0) {
    return {
      severity: 'none',
      summary: 'No forecast for this project, so coverage cannot be checked.',
      newlyShortIntervals: 0,
      days: [],
      hasForecast: false,
    };
  }

  const shiftsByKey = await getShiftsFor([params.userId], dates);
  const days: LeaveImpact[] = [];
  let sawForecast = false;

  for (const date of dates) {
    const shifts = shiftsByKey.get(`${params.userId}|${date}`) ?? [];
    // Not rostered that day: approving costs nothing, so say nothing about it.
    if (shifts.length === 0) continue;

    const { coverage } = await coverageFor({
      projectId: params.projectId,
      date,
      userIds: params.userIds,
    });
    if (coverage.some((c) => c.volume > 0)) sawForecast = true;

    const segments = shifts.flatMap((s) => toSegments(s));
    days.push(
      leaveImpact({
        date,
        coverage,
        coveredIntervals: coveringIntervals(segments, date),
        advisorName: advisor?.name,
      }),
    );
  }

  if (days.length === 0) {
    return {
      severity: 'none',
      summary: 'They are not rostered on any of those days, so cover is unaffected.',
      newlyShortIntervals: 0,
      days: [],
      hasForecast: sawForecast,
    };
  }

  const rolled = summariseLeaveImpact(days);
  return { ...rolled, days, hasForecast: sawForecast };
}

// ----------------------------------------------------------- alert handling

export interface AlertAck {
  alertKey: string;
  userId: number;
  ackedBy: number;
  ackedByName: string;
  note: string | null;
  createdAt: string;
}

/**
 * Who has already picked up which alert today.
 *
 * The alert list is derived fresh on every read — it is a statement about right
 * now, and a stored copy would go stale within a minute. What has to persist is
 * the fact that a human took responsibility, so two supervisors watching the
 * same board do not both ring the same advisor and neither find out.
 */
export async function alertAcks(payrollDate: DateStr): Promise<Map<string, AlertAck>> {
  const rows = await db.all<{
    alert_key: string;
    user_id: number;
    acked_by: number;
    name: string;
    note: string | null;
    created_at: string;
  }>(
    `SELECT a.alert_key, a.user_id, a.acked_by, u.name, a.note, a.created_at
     FROM alert_acks a JOIN users u ON u.id = a.acked_by
     WHERE a.payroll_date = ?`,
    [payrollDate],
  );

  return new Map(
    rows.map((r) => [
      r.alert_key,
      {
        alertKey: r.alert_key,
        userId: r.user_id,
        ackedBy: r.acked_by,
        ackedByName: r.name,
        note: r.note,
        createdAt: r.created_at,
      },
    ]),
  );
}

export async function acknowledgeAlert(params: {
  alertKey: string;
  userId: number;
  payrollDate: DateStr;
  ackedBy: number;
  note?: string;
}): Promise<{ ok: boolean; message: string; ackedByName?: string }> {
  const existing = await db.get<{ acked_by: number; name: string }>(
    `SELECT a.acked_by, u.name FROM alert_acks a JOIN users u ON u.id = a.acked_by
     WHERE a.alert_key = ? AND a.payroll_date = ?`,
    [params.alertKey, params.payrollDate],
  );
  if (existing) {
    // Not an error: two people reaching for the same alert is the situation
    // this exists to resolve, and the second one needs to know who has it.
    return {
      ok: existing.acked_by === params.ackedBy,
      message:
        existing.acked_by === params.ackedBy
          ? 'You already picked this up.'
          : `${existing.name} picked this up first.`,
      ackedByName: existing.name,
    };
  }

  await db.run(
    'INSERT INTO alert_acks (alert_key, user_id, payroll_date, acked_by, note) VALUES (?, ?, ?, ?, ?)',
    [params.alertKey, params.userId, params.payrollDate, params.ackedBy, params.note ?? null],
  );
  return { ok: true, message: 'Picked up. Your team can see you have it.' };
}

export async function releaseAlert(alertKey: string, payrollDate: DateStr): Promise<boolean> {
  const info = await db.run('DELETE FROM alert_acks WHERE alert_key = ? AND payroll_date = ?', [
    alertKey,
    payrollDate,
  ]);
  return info.changes > 0;
}

// ------------------------------------------------------------ payroll export

export interface PayrollExportRow {
  employeeId: string;
  name: string;
  payrollDate: DateStr;
  code: string;
  project: string;
  activity: string;
  minutes: number;
  approved: boolean;
}

/**
 * The file payroll actually wants: one line per advisor, per day, per code,
 * with the minutes totalled.
 *
 * Everything else in the tool stops at a screen. Without this the last step is
 * somebody reading figures off a monitor and typing them into another system,
 * which is where the errors this whole product exists to prevent get
 * reintroduced.
 */
export async function payrollExport(params: {
  userIds: number[];
  start: DateStr;
  end: DateStr;
  /** Leave unapproved cards out, which is what a real run would do. */
  approvedOnly?: boolean;
}): Promise<PayrollExportRow[]> {
  if (params.userIds.length === 0) return [];

  const rows = await db.all<{
    employee_id: string;
    name: string;
    payroll_date: string;
    code: string;
    project: string;
    activity: string;
    start_at: string;
    end_at: string;
    approved: number;
  }>(
    `SELECT u.employee_id, u.name, t.payroll_date, r.code, r.project, r.activity,
            r.start_at, r.end_at, t.approved
     FROM timecard_rows r
     JOIN timecards t ON t.id = r.timecard_id
     JOIN users u ON u.id = t.user_id
     WHERE t.user_id IN (${placeholders(params.userIds.length)})
       AND t.payroll_date BETWEEN ? AND ?
       ${params.approvedOnly ? 'AND t.approved = 1' : ''}
     ORDER BY u.employee_id, t.payroll_date, r.code`,
    [...params.userIds, params.start, params.end],
  );

  // Totalled in JS rather than SQL: the duration is a subtraction of two naive
  // stamps, and the two engines spell that differently. One less dialect.
  const totals = new Map<string, PayrollExportRow>();
  for (const row of rows) {
    const key = `${row.employee_id}|${row.payroll_date}|${row.code}|${row.project}|${row.activity}`;
    const minutes = Math.round(
      (Date.parse(`${row.end_at.replace(' ', 'T')}:00Z`) -
        Date.parse(`${row.start_at.replace(' ', 'T')}:00Z`)) /
        60000,
    );
    const existing = totals.get(key);
    if (existing) existing.minutes += minutes;
    else {
      totals.set(key, {
        employeeId: row.employee_id,
        name: row.name,
        payrollDate: row.payroll_date,
        code: row.code,
        project: row.project,
        activity: row.activity,
        minutes,
        approved: Number(row.approved) === 1,
      });
    }
  }

  return [...totals.values()];
}
