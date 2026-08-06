/**
 * Forecast storage, coverage, and turning a requirement into shifts.
 *
 * The auto-scheduler is deliberately simple and deliberately transparent: it
 * places whole shifts where the shortfall is deepest, one at a time, and stops
 * when the requirement is met or it runs out of people. It will not beat a
 * planner who knows their programme, and it is not meant to — it is meant to
 * produce a defensible starting draft in a second rather than an afternoon.
 */

import { audit, db, transact } from '../db/index.js';
import {
  buildCoverage,
  INTERVAL_MINUTES,
  intervalsOfDay,
  summariseCoverage,
  type CoverageInterval,
} from '../domain/forecast.js';
import type { ScheduleShift } from '../domain/schedule.js';
import { addDays, stamp, type DateStr } from '../domain/time.js';
import { scheduledByInterval } from './intraday.js';
import { getShifts, saveShifts } from './scheduling.js';

export interface ForecastSettings {
  serviceGoal: number;
  targetSeconds: number;
  shrinkage: number;
}

export function getSettings(projectId: string): ForecastSettings {
  const row = db.prepare('SELECT * FROM forecast_settings WHERE project_id = ?').get(projectId) as any;
  return {
    serviceGoal: row?.service_goal ?? 0.8,
    targetSeconds: row?.target_seconds ?? 20,
    shrinkage: row?.shrinkage ?? 0.3,
  };
}

export function saveSettings(projectId: string, settings: ForecastSettings, actorId: number): void {
  db.prepare(
    `INSERT INTO forecast_settings (project_id, service_goal, target_seconds, shrinkage)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       service_goal = excluded.service_goal,
       target_seconds = excluded.target_seconds,
       shrinkage = excluded.shrinkage`,
  ).run(projectId, settings.serviceGoal, settings.targetSeconds, settings.shrinkage);
  audit(actorId, 'forecast', projectId, 'SETTINGS', settings);
}

export interface ForecastRow {
  startTime: string;
  volume: number;
  ahtSeconds: number;
}

export function getForecast(projectId: string, date: DateStr): ForecastRow[] {
  const rows = db
    .prepare(
      'SELECT start_time, volume, aht_seconds FROM forecast_intervals WHERE project_id = ? AND date = ? ORDER BY start_time',
    )
    .all(projectId, date) as { start_time: string; volume: number; aht_seconds: number }[];

  const byTime = new Map(rows.map((r) => [r.start_time, r]));
  // Always return the full grid so the chart has a continuous x axis.
  return intervalsOfDay().map((startTime) => ({
    startTime,
    volume: byTime.get(startTime)?.volume ?? 0,
    ahtSeconds: byTime.get(startTime)?.aht_seconds ?? 240,
  }));
}

export function saveForecast(
  projectId: string,
  date: DateStr,
  rows: ForecastRow[],
  actorId: number,
): void {
  transact(() => {
    const upsert = db.prepare(
      `INSERT INTO forecast_intervals (project_id, date, start_time, volume, aht_seconds, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(project_id, date, start_time) DO UPDATE SET
         volume = excluded.volume, aht_seconds = excluded.aht_seconds, updated_at = datetime('now')`,
    );
    for (const row of rows) {
      upsert.run(projectId, date, row.startTime, Math.max(0, row.volume), Math.max(1, row.ahtSeconds));
    }
    audit(actorId, 'forecast', `${projectId}:${date}`, 'SAVE', { intervals: rows.length });
  });
}

export interface CoverageResult {
  date: DateStr;
  settings: ForecastSettings;
  coverage: CoverageInterval[];
  summary: ReturnType<typeof summariseCoverage>;
}

export function coverageFor(params: {
  projectId: string;
  date: DateStr;
  userIds: number[];
}): CoverageResult {
  const settings = getSettings(params.projectId);
  const intervals = getForecast(params.projectId, params.date);
  const coverage = buildCoverage({
    intervals,
    scheduledByInterval: scheduledByInterval(params.userIds, params.date),
    serviceGoal: settings.serviceGoal,
    targetSeconds: settings.targetSeconds,
    shrinkage: settings.shrinkage,
  });
  return { date: params.date, settings, coverage, summary: summariseCoverage(coverage) };
}

export interface AutoScheduleResult {
  created: { userId: number; name: string; startTime: string; endTime: string }[];
  skipped: { userId: number; name: string; reason: string }[];
  before: ReturnType<typeof summariseCoverage>;
  after: ReturnType<typeof summariseCoverage>;
}

const SHIFT_LENGTH_MINUTES = 8.5 * 60; // eight hours plus an unpaid meal

/**
 * Draft shifts to cover a forecast. Repeatedly finds the worst-covered interval
 * and places a shift over it, using whoever is free that day, until either the
 * gap closes or everybody is rostered.
 */
export function autoSchedule(params: {
  projectId: string;
  date: DateStr;
  userIds: number[];
  actorId: number;
  maxShifts?: number;
}): AutoScheduleResult {
  const { projectId, date, userIds, actorId } = params;
  const settings = getSettings(projectId);
  const intervals = getForecast(projectId, date);

  const before = summariseCoverage(
    buildCoverage({
      intervals,
      scheduledByInterval: scheduledByInterval(userIds, date),
      ...settings,
    }),
  );

  const available = db
    .prepare(
      `SELECT id, name FROM users WHERE id IN (${userIds.map(() => '?').join(',') || 'NULL'})
         AND role = 'ADVISOR' AND status = 'ACTIVE' ORDER BY name`,
    )
    .all(...userIds) as { id: number; name: string }[];

  const created: AutoScheduleResult['created'] = [];
  const skipped: AutoScheduleResult['skipped'] = [];
  const free = available.filter((u) => {
    if (getShifts(u.id, date).length > 0) {
      skipped.push({ userId: u.id, name: u.name, reason: 'Already has a shift on this date.' });
      return false;
    }
    return true;
  });

  const limit = Math.min(params.maxShifts ?? free.length, free.length);

  for (let placed = 0; placed < limit; placed++) {
    const coverage = buildCoverage({
      intervals,
      scheduledByInterval: scheduledByInterval(userIds, date),
      ...settings,
    });

    const worst = coverage
      .filter((c) => c.volume > 0 && c.variance < 0)
      .sort((a, b) => a.variance - b.variance)[0];
    if (!worst) break; // requirement met

    // Centre a shift on the gap, then clamp it into the day.
    const gapMinutes = timeToMinutes(worst.startTime);
    let startMinutes = Math.max(0, Math.min(1440 - SHIFT_LENGTH_MINUTES, gapMinutes - 120));
    startMinutes = Math.round(startMinutes / INTERVAL_MINUTES) * INTERVAL_MINUTES;

    const user = free[placed];
    const shift = buildShift(date, startMinutes);
    const result = saveShifts({ userId: user.id, date, shifts: [shift], actorId, source: 'AUTO' });

    if (result.ok) {
      created.push({
        userId: user.id,
        name: user.name,
        startTime: minutesToTime(startMinutes),
        endTime: minutesToTime((startMinutes + SHIFT_LENGTH_MINUTES) % 1440),
      });
    } else {
      skipped.push({
        userId: user.id,
        name: user.name,
        reason: result.issues.find((i) => i.level === 'error')?.message ?? 'Could not be scheduled.',
      });
    }
  }

  const after = summariseCoverage(
    buildCoverage({
      intervals,
      scheduledByInterval: scheduledByInterval(userIds, date),
      ...settings,
    }),
  );

  audit(actorId, 'forecast', `${projectId}:${date}`, 'AUTO_SCHEDULE', {
    created: created.length,
    before: before.understaffedIntervals,
    after: after.understaffedIntervals,
  });

  return { created, skipped, before, after };
}

/** A standard shift: start, break, meal, break, end. */
function buildShift(date: DateStr, startMinutes: number): ScheduleShift {
  const at = (offset: number) => {
    const total = startMinutes + offset;
    const day = total >= 1440 ? addDays(date, 1) : date;
    return stamp(day, minutesToTime(total % 1440));
  };

  return {
    shiftNo: 1,
    rows: [
      { startAt: at(0), activityKey: 'SHIFT_START' },
      { startAt: at(120), activityKey: 'BREAK' },
      { startAt: at(135), activityKey: 'OPEN_TIME' },
      { startAt: at(240), activityKey: 'LUNCH' },
      { startAt: at(270), activityKey: 'OPEN_TIME' },
      { startAt: at(420), activityKey: 'BREAK' },
      { startAt: at(435), activityKey: 'OPEN_TIME' },
    ],
    endAt: at(SHIFT_LENGTH_MINUTES),
  };
}

function timeToMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function minutesToTime(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
