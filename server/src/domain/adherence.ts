/**
 * The Pulse Report — schedule versus reality for one advisor and one day.
 *
 * This is the report a supervisor reads first thing every morning. It puts
 * clock data and schedule data side by side, works out how much of the shift
 * was spent in the state the advisor was planned to be in, and calls out the
 * two things worth asking about: activities they punched into that nobody
 * scheduled, and scheduled activities they never punched into at all.
 */

import { ACTIVITY_MAP, CODE_MAP } from './reference.js';
import { toSegments, type ScheduleShift } from './schedule.js';
import type { TimecardRow } from './timecard.js';
import { rowMinutes, sortRows } from './timecard.js';
import { type Stamp, diffMinutes, formatDuration, fromMinutes, toMinutes } from './time.js';

export interface AdherenceBand {
  startAt: Stamp;
  endAt: Stamp;
  scheduled: string | null;
  actual: string | null;
  adherent: boolean;
}

export interface ActivityTotal {
  activity: string;
  name: string;
  minutes: number;
  formatted: string;
}

export interface AdherenceReport {
  scheduledMinutes: number;
  actualMinutes: number;
  adherentMinutes: number;
  /** Percentage of scheduled time spent in the planned state, 0-100. */
  adherencePct: number;
  bands: AdherenceBand[];
  unscheduledActivities: ActivityTotal[];
  missedActivities: ActivityTotal[];
  scheduledTotals: ActivityTotal[];
  actualTotals: ActivityTotal[];
  exceptions: { code: string; name: string; minutes: number; formatted: string }[];
  observations: string[];
}

/** Activities that all count as "on the job" for adherence purposes. */
const PRODUCTIVE = new Set(['01-001', '01-002', '02-001', '03-001', '07-001', '07-002']);

function comparable(activity: string | null): string | null {
  if (!activity) return null;
  return PRODUCTIVE.has(activity) ? 'PRODUCTIVE' : activity;
}

export function buildAdherenceReport(params: {
  shifts: ScheduleShift[];
  rows: TimecardRow[];
}): AdherenceReport {
  const { shifts, rows } = params;
  const scheduled = shifts.flatMap((s) => toSegments(s));
  const actual = sortRows(rows);

  const stamps = [
    ...scheduled.flatMap((s) => [s.startAt, s.endAt]),
    ...actual.flatMap((r) => [r.startAt, r.endAt]),
  ];

  if (stamps.length === 0) {
    return emptyReport();
  }

  const from = Math.min(...stamps.map(toMinutes));
  const to = Math.max(...stamps.map(toMinutes));

  // Minute grid across the union of planned and actual time. A day of work is
  // at most a couple of thousand minutes, so this stays cheap and exact.
  const scheduleAt = new Map<number, string>();
  for (const seg of scheduled) {
    if (!seg.activity) continue;
    for (let m = toMinutes(seg.startAt); m < toMinutes(seg.endAt); m++) scheduleAt.set(m, seg.activity);
  }
  const actualAt = new Map<number, string>();
  for (const row of actual) {
    if (!row.activity) continue;
    // Absence-style rows describe time the advisor was not there; they are not
    // an actual state, they are the absence of one.
    if (row.activity === '99-003') continue;
    for (let m = toMinutes(row.startAt); m < toMinutes(row.endAt); m++) actualAt.set(m, row.activity);
  }

  const bands: AdherenceBand[] = [];
  let adherentMinutes = 0;
  let scheduledMinutes = 0;
  let currentKey = '';
  for (let m = from; m < to; m++) {
    const sched = scheduleAt.get(m) ?? null;
    const act = actualAt.get(m) ?? null;
    const adherent = comparable(sched) !== null && comparable(sched) === comparable(act);
    if (sched) scheduledMinutes++;
    if (adherent) adherentMinutes++;

    const key = `${sched}|${act}|${adherent}`;
    const last = bands[bands.length - 1];
    if (last && key === currentKey) {
      last.endAt = fromMinutes(m + 1);
    } else {
      bands.push({ startAt: fromMinutes(m), endAt: fromMinutes(m + 1), scheduled: sched, actual: act, adherent });
      currentKey = key;
    }
  }

  const scheduledTotals = totals(scheduleAt);
  const actualTotals = totals(actualAt);

  const scheduledSet = new Set(scheduledTotals.map((t) => t.activity));
  const actualSet = new Set(actualTotals.map((t) => t.activity));

  const unscheduledActivities = actualTotals.filter((t) => !scheduledSet.has(t.activity));
  const missedActivities = scheduledTotals.filter((t) => !actualSet.has(t.activity));

  const exceptionTotals = new Map<string, number>();
  for (const row of actual) {
    const meta = CODE_MAP.get(row.code);
    if (!meta?.exception) continue;
    exceptionTotals.set(row.code, (exceptionTotals.get(row.code) ?? 0) + Math.max(0, rowMinutes(row)));
  }

  const observations: string[] = [];
  for (const t of unscheduledActivities) {
    observations.push(`Punched ${t.formatted} into ${t.activity} ${t.name}, which was not on the schedule.`);
  }
  for (const t of missedActivities) {
    observations.push(`Scheduled ${t.formatted} of ${t.activity} ${t.name} but never punched into it.`);
  }
  for (const [code, minutes] of exceptionTotals) {
    const meta = CODE_MAP.get(code);
    observations.push(`${meta?.name ?? code}: ${formatDuration(minutes)} — ${meta?.description ?? ''}`.trim());
  }

  const actualMinutes = actualAt.size;

  return {
    scheduledMinutes,
    actualMinutes,
    adherentMinutes,
    adherencePct: scheduledMinutes === 0 ? 0 : Math.round((adherentMinutes / scheduledMinutes) * 1000) / 10,
    bands,
    unscheduledActivities,
    missedActivities,
    scheduledTotals,
    actualTotals,
    exceptions: [...exceptionTotals.entries()]
      .map(([code, minutes]) => ({
        code,
        name: CODE_MAP.get(code)?.name ?? code,
        minutes,
        formatted: formatDuration(minutes),
      }))
      .sort((a, b) => b.minutes - a.minutes),
    observations,
  };
}

function totals(grid: Map<number, string>): ActivityTotal[] {
  const acc = new Map<string, number>();
  for (const activity of grid.values()) acc.set(activity, (acc.get(activity) ?? 0) + 1);
  return [...acc.entries()]
    .map(([activity, minutes]) => ({
      activity,
      name: ACTIVITY_MAP.get(activity)?.name ?? activity,
      minutes,
      formatted: formatDuration(minutes),
    }))
    .sort((a, b) => b.minutes - a.minutes);
}

function emptyReport(): AdherenceReport {
  return {
    scheduledMinutes: 0,
    actualMinutes: 0,
    adherentMinutes: 0,
    adherencePct: 0,
    bands: [],
    unscheduledActivities: [],
    missedActivities: [],
    scheduledTotals: [],
    actualTotals: [],
    exceptions: [],
    observations: [],
  };
}

/** First punch versus first scheduled minute, for the report header. */
export function punctuality(shifts: ScheduleShift[], rows: TimecardRow[]) {
  const scheduled = shifts.flatMap((s) => toSegments(s));
  const worked = sortRows(rows).filter((r) => r.activity !== '99-003');
  if (scheduled.length === 0 || worked.length === 0) return null;
  const schedStart = scheduled[0].startAt;
  const schedEnd = scheduled[scheduled.length - 1].endAt;
  const actualStart = worked[0].startAt;
  const actualEnd = worked[worked.length - 1].endAt;
  return {
    scheduledStart: schedStart,
    scheduledEnd: schedEnd,
    actualStart,
    actualEnd,
    startVarianceMinutes: diffMinutes(schedStart, actualStart),
    endVarianceMinutes: diffMinutes(schedEnd, actualEnd),
  };
}
