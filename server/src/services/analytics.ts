/**
 * Analytics over the data the tool already captures.
 *
 * Nothing here is a new measurement — it is the same timecards and schedules
 * read across time instead of a day at a time, which is where patterns live. A
 * single Long Lunch is a conversation; the same advisor with twelve of them in
 * a month is a different conversation, and only this view shows it.
 */

import { db } from '../db/index.js';
import { CODE_MAP, TIMECARD_CODES } from '../domain/reference.js';
import { buildAdherenceReport } from '../domain/adherence.js';
import { toSegments } from '../domain/schedule.js';
import { dateRange, formatDuration, type DateStr } from '../domain/time.js';
import { placeholders } from './people.js';
import { getShiftsFor } from './scheduling.js';
import { viewTimecard } from './timecards.js';

export interface TrendPoint {
  date: DateStr;
  adherencePct: number;
  regularHours: number;
  absenceHours: number;
  exceptions: number;
  headcount: number;
}

export interface Scorecard {
  userId: number;
  employeeId: string;
  name: string;
  daysWorked: number;
  adherencePct: number;
  regularHours: number;
  absenceHours: number;
  lateCount: number;
  lateMinutes: number;
  leaveEarlyCount: number;
  longLunchCount: number;
  absenceCount: number;
  exceptionCount: number;
}

export interface AnalyticsResult {
  start: DateStr;
  end: DateStr;
  trend: TrendPoint[];
  scorecards: Scorecard[];
  exceptionMix: { code: string; name: string; count: number; minutes: number; formatted: string }[];
  shrinkage: { activity: string; name: string; minutes: number; formatted: string; pct: number }[];
  totals: {
    adherencePct: number;
    regularHours: number;
    absenceHours: number;
    exceptions: number;
    advisors: number;
  };
}

/**
 * Build the whole analytics payload for a group and range. Deliberately
 * computed on read rather than kept in a rollup table: the dataset here is
 * small, and a stale aggregate that disagrees with the timecard it came from
 * would cost more trust than the query costs milliseconds.
 */
export async function analyse(params: {
  userIds: number[];
  start: DateStr;
  end: DateStr;
  actorId: number | null;
}): Promise<AnalyticsResult> {
  const { userIds, start, end } = params;
  const dates = dateRange(start, end);

  const scorecards = new Map<number, Scorecard>();
  const trend: TrendPoint[] = [];
  const exceptionCounts = new Map<string, { count: number; minutes: number }>();
  const shrinkageMinutes = new Map<string, number>();

  if (userIds.length === 0) {
    return emptyResult(start, end);
  }

  const users = await db.all<{ id: number; employee_id: string; name: string }>(
    `SELECT id, employee_id, name FROM users
     WHERE id IN (${placeholders(userIds.length)}) AND role = 'ADVISOR' ORDER BY name`,
    userIds,
  );

  // Every schedule in the range, once. The loop below runs users × dates, so a
  // read inside it would be a fortnight of round trips per advisor.
  const shiftsByKey = await getShiftsFor(
    users.map((u) => u.id),
    dates,
  );

  for (const user of users) {
    scorecards.set(user.id, {
      userId: user.id,
      employeeId: user.employee_id,
      name: user.name,
      daysWorked: 0,
      adherencePct: 0,
      regularHours: 0,
      absenceHours: 0,
      lateCount: 0,
      lateMinutes: 0,
      leaveEarlyCount: 0,
      longLunchCount: 0,
      absenceCount: 0,
      exceptionCount: 0,
    });
  }

  // Adherence is averaged per advisor-day, so a day with more people counts more.
  const adherenceByUser = new Map<number, number[]>();

  for (const date of dates) {
    let dayAdherenceSum = 0;
    let dayAdherenceCount = 0;
    let dayRegular = 0;
    let dayAbsence = 0;
    let dayExceptions = 0;
    let dayHeadcount = 0;

    for (const user of users) {
      const card = await viewTimecard({ userId: user.id, date, autoGenerate: false });
      if (!card || card.rows.length === 0) continue;

      dayHeadcount++;
      const sheet = scorecards.get(user.id)!;
      sheet.daysWorked++;

      const regular = card.summary.regularMinutes / 60;
      const absence = card.summary.absenceMinutes / 60;
      sheet.regularHours += regular;
      sheet.absenceHours += absence;
      dayRegular += regular;
      dayAbsence += absence;

      for (const row of card.rows) {
        const meta = CODE_MAP.get(row.code);
        const minutes = Math.max(
          0,
          (Date.parse(row.endAt.replace(' ', 'T') + 'Z') - Date.parse(row.startAt.replace(' ', 'T') + 'Z')) /
            60000,
        );

        if (meta?.exception) {
          const acc = exceptionCounts.get(row.code) ?? { count: 0, minutes: 0 };
          exceptionCounts.set(row.code, { count: acc.count + 1, minutes: acc.minutes + minutes });
          sheet.exceptionCount++;
          dayExceptions++;

          if (row.code === 'LT') {
            sheet.lateCount++;
            sheet.lateMinutes += minutes;
          }
          if (row.code === 'LE') sheet.leaveEarlyCount++;
          if (row.code === 'LLU') sheet.longLunchCount++;
          if (row.code === 'ABS' || row.code === 'NCS') sheet.absenceCount++;
        }

        // Everything paid that is not productive is shrinkage.
        if (row.code === 'BRK' || row.code === 'LUN' || ['12-001', '12-002', '15-001', '15-002', '16-001', '16-003'].includes(row.activity)) {
          shrinkageMinutes.set(row.activity, (shrinkageMinutes.get(row.activity) ?? 0) + minutes);
        }
      }

      const shifts = shiftsByKey.get(`${user.id}|${date}`) ?? [];
      if (shifts.length > 0) {
        const report = buildAdherenceReport({ shifts, rows: card.rows });
        dayAdherenceSum += report.adherencePct;
        dayAdherenceCount++;
        const list = adherenceByUser.get(user.id) ?? [];
        list.push(report.adherencePct);
        adherenceByUser.set(user.id, list);
      }
    }

    if (dayHeadcount > 0) {
      trend.push({
        date,
        adherencePct: dayAdherenceCount > 0 ? round(dayAdherenceSum / dayAdherenceCount, 1) : 0,
        regularHours: round(dayRegular, 1),
        absenceHours: round(dayAbsence, 1),
        exceptions: dayExceptions,
        headcount: dayHeadcount,
      });
    }
  }

  for (const [userId, values] of adherenceByUser) {
    const sheet = scorecards.get(userId);
    if (sheet) sheet.adherencePct = round(values.reduce((a, b) => a + b, 0) / values.length, 1);
  }

  for (const sheet of scorecards.values()) {
    sheet.regularHours = round(sheet.regularHours, 1);
    sheet.absenceHours = round(sheet.absenceHours, 1);
    sheet.lateMinutes = Math.round(sheet.lateMinutes);
  }

  const totalShrinkage = [...shrinkageMinutes.values()].reduce((a, b) => a + b, 0);
  const scorecardList = [...scorecards.values()].filter((s) => s.daysWorked > 0);

  return {
    start,
    end,
    trend,
    scorecards: scorecardList.sort((a, b) => b.exceptionCount - a.exceptionCount),
    exceptionMix: [...exceptionCounts.entries()]
      .map(([code, v]) => ({
        code,
        name: TIMECARD_CODES.find((c) => c.code === code)?.name ?? code,
        count: v.count,
        minutes: Math.round(v.minutes),
        formatted: formatDuration(v.minutes),
      }))
      .sort((a, b) => b.count - a.count),
    shrinkage: [...shrinkageMinutes.entries()]
      .map(([activity, minutes]) => ({
        activity,
        name: shrinkageLabel(activity),
        minutes: Math.round(minutes),
        formatted: formatDuration(minutes),
        pct: totalShrinkage > 0 ? round((minutes / totalShrinkage) * 100, 1) : 0,
      }))
      .sort((a, b) => b.minutes - a.minutes),
    totals: {
      adherencePct:
        trend.length > 0 ? round(trend.reduce((s, t) => s + t.adherencePct, 0) / trend.length, 1) : 0,
      regularHours: round(scorecardList.reduce((s, c) => s + c.regularHours, 0), 1),
      absenceHours: round(scorecardList.reduce((s, c) => s + c.absenceHours, 0), 1),
      exceptions: scorecardList.reduce((s, c) => s + c.exceptionCount, 0),
      advisors: scorecardList.length,
    },
  };
}

function shrinkageLabel(activity: string): string {
  const labels: Record<string, string> = {
    '26-001': 'Break',
    '99-001': 'Lunch',
    '12-001': 'Team Meeting',
    '12-002': 'Focus Group',
    '15-001': 'Training',
    '15-002': 'CE Training',
    '16-001': 'Coaching/Feedback',
    '16-003': 'Quality Coaching',
  };
  return labels[activity] ?? activity;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function emptyResult(start: DateStr, end: DateStr): AnalyticsResult {
  return {
    start,
    end,
    trend: [],
    scorecards: [],
    exceptionMix: [],
    shrinkage: [],
    totals: { adherencePct: 0, regularHours: 0, absenceHours: 0, exceptions: 0, advisors: 0 },
  };
}
