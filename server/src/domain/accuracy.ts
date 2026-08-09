/**
 * How wrong the forecast was.
 *
 * A forecast nobody checks is a guess with a spreadsheet around it. Every
 * staffing number downstream — required agents, service level, roster cost —
 * rests on one, and until something records what actually arrived there is no
 * way to know whether any of it was close.
 *
 * Three measures, because they answer three different questions and a single
 * "accuracy" number hides the one that matters.
 *
 * **MAPE** — mean absolute percentage error — is the headline, and the number
 * planners already talk in. It is the average of |actual − forecast| ÷ actual.
 *
 * **WAPE** — weighted absolute percentage error — divides the total error by
 * the total volume instead of averaging the per-interval percentages. This is
 * the honest one for a contact centre. A quiet interval forecast at 2 calls
 * that takes 4 is 100% wrong and means nothing; a busy interval forecast at
 * 400 that takes 440 is 10% wrong and is the reason the queue collapsed. MAPE
 * treats those two as equally bad and can be dominated entirely by the night
 * shift. WAPE cannot.
 *
 * **Bias** — signed, not absolute — is the one people forget and the one that
 * costs money. A forecast that is 8% high every single interval has the same
 * MAPE as one that alternates ±8%, and they are completely different problems:
 * the first is over-staffing every day and can be corrected by a constant, the
 * second is noise. Positive bias here means the forecast was *under* what
 * arrived, so the floor was short.
 */

import type { DateStr } from './time.js';

export interface IntervalActual {
  date: DateStr;
  startTime: string;
  /** What was planned. */
  forecastVolume: number;
  forecastAht: number;
  /** What arrived. Null where nothing has been recorded for the interval. */
  actualVolume: number | null;
  actualAht: number | null;
}

export interface AccuracyResult {
  /** Intervals with an actual recorded. Everything below is over these only. */
  measured: number;
  /** Intervals with a forecast but no actual, which is a data gap not an error. */
  unmeasured: number;
  forecastTotal: number;
  actualTotal: number;
  /** Mean absolute percentage error, 0-1. Null when nothing is measurable. */
  mape: number | null;
  /** Volume-weighted absolute percentage error, 0-1. The one to lead with. */
  wape: number | null;
  /** Signed error as a fraction of actual. Positive means the forecast was low. */
  bias: number | null;
  /** Mean absolute error in calls, for people who think in calls. */
  mae: number | null;
  /** The same, for handling time. */
  ahtBiasSeconds: number | null;
  /** Whichever intervals were furthest out, worst first. */
  worst: IntervalError[];
}

export interface IntervalError {
  date: DateStr;
  startTime: string;
  forecastVolume: number;
  actualVolume: number;
  /** Signed: positive when more arrived than was forecast. */
  error: number;
  /** Signed, as a fraction of actual. Null when nothing arrived. */
  errorPct: number | null;
}

const WORST_COUNT = 8;

export function measureAccuracy(rows: readonly IntervalActual[]): AccuracyResult {
  const measured = rows.filter((r) => r.actualVolume !== null);
  const unmeasured = rows.length - measured.length;

  const forecastTotal = measured.reduce((sum, r) => sum + r.forecastVolume, 0);
  const actualTotal = measured.reduce((sum, r) => sum + (r.actualVolume ?? 0), 0);

  const errors: IntervalError[] = measured.map((r) => {
    const actual = r.actualVolume ?? 0;
    const error = actual - r.forecastVolume;
    return {
      date: r.date,
      startTime: r.startTime,
      forecastVolume: r.forecastVolume,
      actualVolume: actual,
      error,
      // An interval where nothing arrived has no percentage — dividing by zero
      // would report infinite error for a genuinely quiet half hour.
      errorPct: actual === 0 ? null : error / actual,
    };
  });

  const percentable = errors.filter((e) => e.errorPct !== null);
  const absoluteTotal = errors.reduce((sum, e) => sum + Math.abs(e.error), 0);

  const ahtPairs = measured.filter((r) => r.actualAht !== null && (r.actualVolume ?? 0) > 0);

  return {
    measured: measured.length,
    unmeasured,
    forecastTotal,
    actualTotal,
    mape:
      percentable.length === 0
        ? null
        : percentable.reduce((sum, e) => sum + Math.abs(e.errorPct!), 0) / percentable.length,
    wape: actualTotal === 0 ? null : absoluteTotal / actualTotal,
    bias: actualTotal === 0 ? null : (actualTotal - forecastTotal) / actualTotal,
    mae: errors.length === 0 ? null : absoluteTotal / errors.length,
    ahtBiasSeconds:
      ahtPairs.length === 0
        ? null
        : ahtPairs.reduce((sum, r) => sum + (r.actualAht! - r.forecastAht), 0) / ahtPairs.length,
    // Ranked by absolute calls rather than by percentage, for the same reason
    // WAPE exists: the worst intervals are the ones that hurt, and a quiet
    // interval that doubled from 2 to 4 did not hurt.
    worst: [...errors].sort((a, b) => Math.abs(b.error) - Math.abs(a.error)).slice(0, WORST_COUNT),
  };
}

/**
 * A plain reading of the numbers.
 *
 * The point of the loop is that somebody changes the next forecast, and
 * "WAPE 0.14, bias +0.09" is not an instruction. This turns it into one.
 */
export function interpret(result: AccuracyResult): string[] {
  const notes: string[] = [];
  if (result.measured === 0) {
    notes.push('No actual volume has been recorded for this period, so accuracy cannot be measured.');
    return notes;
  }

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  if (result.wape !== null) {
    const quality =
      result.wape <= 0.05 ? 'very good' : result.wape <= 0.1 ? 'good' : result.wape <= 0.2 ? 'workable' : 'poor';
    notes.push(`Weighted error ${pct(result.wape)} — ${quality} for a contact centre.`);
  }

  // A consistent direction is worth saying out loud, because it is the one
  // kind of error a planner can correct with a single number.
  if (result.bias !== null && Math.abs(result.bias) >= 0.05) {
    notes.push(
      result.bias > 0
        ? `The forecast ran ${pct(result.bias)} low overall, so the floor was short against what arrived.`
        : `The forecast ran ${pct(-result.bias)} high overall, so the floor was staffed for work that did not come.`,
    );
  } else if (result.bias !== null) {
    // The figure is quoted even when it is small, because the screen shows it
    // next to this sentence and "no consistent direction" beside a +4.9% tile
    // reads as a contradiction rather than as a judgement about size.
    notes.push(
      `The error has no strong direction (${result.bias > 0 ? '+' : ''}${pct(result.bias)}) — ` +
        'small enough to be noise rather than something a single correction would fix.',
    );
  }

  if (result.ahtBiasSeconds !== null && Math.abs(result.ahtBiasSeconds) >= 10) {
    notes.push(
      result.ahtBiasSeconds > 0
        ? `Calls ran ${Math.round(result.ahtBiasSeconds)}s longer than planned, which costs staffing even when volume is right.`
        : `Calls ran ${Math.round(-result.ahtBiasSeconds)}s shorter than planned.`,
    );
  }

  if (result.unmeasured > 0) {
    notes.push(
      `${result.unmeasured} ${result.unmeasured === 1 ? 'interval has' : 'intervals have'} no actual recorded and ${result.unmeasured === 1 ? 'is' : 'are'} excluded.`,
    );
  }

  return notes;
}
