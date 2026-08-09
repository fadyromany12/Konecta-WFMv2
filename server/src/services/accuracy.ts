/**
 * Recording what arrived, and comparing it with what was planned.
 *
 * The forecast half of this already existed. This is the other half — without
 * it, `forecast_intervals` holds an opinion nobody has ever checked, and every
 * staffing number computed from it inherits that.
 */

import { audit, db, insertMany, transact } from '../db/index.js';
import { measureAccuracy, interpret, type AccuracyResult, type IntervalActual } from '../domain/accuracy.js';
import { dateRange, nowStamp, type DateStr } from '../domain/time.js';

export interface ActualRow {
  startTime: string;
  volume: number;
  ahtSeconds: number | null;
}

/**
 * Record the volume that actually arrived.
 *
 * Replaces the day wholesale rather than merging interval by interval. A
 * partial upload is the normal case — a feed re-sends a corrected morning —
 * and merging would leave yesterday's wrong numbers sitting in the intervals
 * the new file happens not to mention.
 */
export async function saveActuals(params: {
  projectId: string;
  date: DateStr;
  rows: ActualRow[];
  actorId: number;
  source?: string;
}): Promise<{ saved: number }> {
  const source = params.source ?? 'MANUAL';
  const stamp = nowStamp();

  await transact(async () => {
    await db.run('DELETE FROM actual_intervals WHERE project_id = ? AND date = ?', [
      params.projectId,
      params.date,
    ]);
    if (params.rows.length > 0) {
      await insertMany(
        'actual_intervals',
        ['project_id', 'date', 'start_time', 'volume', 'aht_seconds', 'source', 'recorded_by', 'updated_at'],
        params.rows.map((row) => [
          params.projectId,
          params.date,
          row.startTime,
          row.volume,
          row.ahtSeconds,
          source,
          params.actorId,
          stamp,
        ]),
      );
    }
    await audit(params.actorId, 'actuals', `${params.projectId}:${params.date}`, 'SAVE_ACTUALS', {
      intervals: params.rows.length,
      source,
    });
  });

  return { saved: params.rows.length };
}

export async function getActuals(projectId: string, date: DateStr): Promise<ActualRow[]> {
  const rows = await db.all<{ start_time: string; volume: number; aht_seconds: number | null }>(
    'SELECT start_time, volume, aht_seconds FROM actual_intervals WHERE project_id = ? AND date = ? ORDER BY start_time',
    [projectId, date],
  );
  return rows.map((r) => ({ startTime: r.start_time, volume: r.volume, ahtSeconds: r.aht_seconds }));
}

export interface AccuracyReport extends AccuracyResult {
  projectId: string;
  start: DateStr;
  end: DateStr;
  notes: string[];
  /** One row per day, so a bad Tuesday is visible rather than averaged away. */
  byDay: { date: DateStr; forecast: number; actual: number; wape: number | null; bias: number | null }[];
}

/**
 * How the forecast did over a period.
 *
 * Both sides are read in one query each and joined in memory rather than with
 * an outer join across two tables per interval. The set is at most 48 rows a
 * day and the join direction matters: an interval that was forecast but never
 * measured, and one that arrived but was never forecast, are different facts
 * and both have to survive into the result.
 */
export async function accuracyFor(params: {
  projectId: string;
  start: DateStr;
  end: DateStr;
}): Promise<AccuracyReport> {
  const [forecasts, actuals] = await Promise.all([
    db.all<{ date: string; start_time: string; volume: number; aht_seconds: number }>(
      `SELECT date, start_time, volume, aht_seconds FROM forecast_intervals
       WHERE project_id = ? AND date BETWEEN ? AND ?`,
      [params.projectId, params.start, params.end],
    ),
    db.all<{ date: string; start_time: string; volume: number; aht_seconds: number | null }>(
      `SELECT date, start_time, volume, aht_seconds FROM actual_intervals
       WHERE project_id = ? AND date BETWEEN ? AND ?`,
      [params.projectId, params.start, params.end],
    ),
  ]);

  const key = (date: string, time: string) => `${date} ${time}`;
  const actualBy = new Map(actuals.map((a) => [key(a.date, a.start_time), a]));

  const rows: IntervalActual[] = forecasts.map((f) => {
    const actual = actualBy.get(key(f.date, f.start_time));
    return {
      date: f.date,
      startTime: f.start_time,
      forecastVolume: f.volume,
      forecastAht: f.aht_seconds,
      actualVolume: actual ? actual.volume : null,
      actualAht: actual ? actual.aht_seconds : null,
    };
  });

  // Volume that arrived in an interval nobody forecast is a forecast error of
  // the whole amount, not an absence of data. Dropping it would let a planner
  // improve their score by forecasting fewer intervals.
  const forecastKeys = new Set(forecasts.map((f) => key(f.date, f.start_time)));
  for (const a of actuals) {
    if (forecastKeys.has(key(a.date, a.start_time))) continue;
    rows.push({
      date: a.date,
      startTime: a.start_time,
      forecastVolume: 0,
      forecastAht: 0,
      actualVolume: a.volume,
      actualAht: a.aht_seconds,
    });
  }

  const overall = measureAccuracy(rows);

  const byDay = dateRange(params.start, params.end)
    .map((date) => {
      const dayRows = rows.filter((r) => r.date === date);
      const day = measureAccuracy(dayRows);
      return {
        date,
        forecast: day.forecastTotal,
        actual: day.actualTotal,
        wape: day.wape,
        bias: day.bias,
        measured: day.measured,
      };
    })
    // A day with nothing recorded either side is not a day with a problem.
    .filter((d) => d.measured > 0 || d.forecast > 0)
    .map(({ measured: _measured, ...rest }) => rest);

  return {
    ...overall,
    projectId: params.projectId,
    start: params.start,
    end: params.end,
    notes: interpret(overall),
    byDay,
  };
}
