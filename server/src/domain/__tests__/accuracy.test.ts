import { describe, expect, it } from 'vitest';
import { interpret, measureAccuracy, type IntervalActual } from '../accuracy.js';

const at = (
  startTime: string,
  forecastVolume: number,
  actualVolume: number | null,
  forecastAht = 240,
  actualAht: number | null = 240,
): IntervalActual => ({
  date: '2026-08-03',
  startTime,
  forecastVolume,
  forecastAht,
  actualVolume,
  actualAht,
});

describe('measuring a forecast against what arrived', () => {
  it('reports a perfect forecast as no error at all', () => {
    const out = measureAccuracy([at('09:00', 100, 100), at('09:30', 200, 200)]);
    expect(out.mape).toBe(0);
    expect(out.wape).toBe(0);
    expect(out.bias).toBe(0);
    expect(out.mae).toBe(0);
  });

  it('counts intervals with no actual as unmeasured rather than as error', () => {
    const out = measureAccuracy([at('09:00', 100, 100), at('09:30', 200, null)]);
    expect(out.measured).toBe(1);
    expect(out.unmeasured).toBe(1);
    expect(out.wape).toBe(0);
    // The unmeasured interval's forecast must not reach the totals either, or
    // the bias would report a shortfall that is really a missing reading.
    expect(out.forecastTotal).toBe(100);
  });

  it('weights a busy interval above a quiet one, which is the whole point', () => {
    // Error is measured against what arrived, as MAPE conventionally is. The
    // quiet interval took 4 where 2 were forecast, so it is 50% out; the busy
    // one took 440 where 400 were forecast, so it is 9.1% out.
    const out = measureAccuracy([at('03:00', 2, 4), at('11:00', 400, 440)]);
    // MAPE averages those and reports 30% — a number driven mostly by an
    // interval that was two calls wrong.
    expect(out.mape).toBeCloseTo((0.5 + 40 / 440) / 2, 4);
    // WAPE divides total error by total volume: 42 of 444.
    expect(out.wape).toBeCloseTo(42 / 444, 4);
    expect(out.wape!).toBeLessThan(out.mape!);
  });

  it('reports bias signed, so a consistent direction is visible', () => {
    // Every interval came in higher than forecast: the floor was short.
    const low = measureAccuracy([at('09:00', 90, 100), at('09:30', 180, 200)]);
    expect(low.bias).toBeCloseTo(0.1, 6);

    const high = measureAccuracy([at('09:00', 110, 100), at('09:30', 220, 200)]);
    expect(high.bias).toBeCloseTo(-0.1, 6);
  });

  it('separates a consistent error from noise of the same size', () => {
    const consistent = measureAccuracy([at('09:00', 90, 100), at('09:30', 90, 100)]);
    const noisy = measureAccuracy([at('09:00', 90, 100), at('09:30', 110, 100)]);
    // Same absolute error either way.
    expect(consistent.mae).toBe(noisy.mae);
    // Completely different bias, which is what tells them apart.
    expect(consistent.bias).toBeCloseTo(0.1, 6);
    expect(noisy.bias).toBeCloseTo(0, 6);
  });

  it('does not divide by zero on an interval where nothing arrived', () => {
    const out = measureAccuracy([at('03:00', 5, 0), at('09:00', 100, 100)]);
    expect(Number.isFinite(out.mape!)).toBe(true);
    // The zero interval still contributes its 5 calls of absolute error.
    expect(out.wape).toBeCloseTo(5 / 100, 6);
  });

  it('returns nulls rather than NaN when nothing is measurable', () => {
    const out = measureAccuracy([at('09:00', 100, null)]);
    expect(out.mape).toBeNull();
    expect(out.wape).toBeNull();
    expect(out.bias).toBeNull();
    expect(out.measured).toBe(0);
  });

  it('handles an empty period', () => {
    const out = measureAccuracy([]);
    expect(out.measured).toBe(0);
    expect(out.worst).toEqual([]);
    expect(out.mae).toBeNull();
  });

  it('ranks the worst intervals by calls, not by percentage', () => {
    const out = measureAccuracy([at('03:00', 1, 5), at('11:00', 400, 340)]);
    // The quiet one is 400% out; the busy one is 60 calls out and is the one
    // that emptied the queue.
    expect(out.worst[0].startTime).toBe('11:00');
    expect(out.worst[0].error).toBe(-60);
  });

  it('measures handling time separately from volume', () => {
    const out = measureAccuracy([at('09:00', 100, 100, 240, 300), at('09:30', 100, 100, 240, 300)]);
    expect(out.wape).toBe(0);
    expect(out.ahtBiasSeconds).toBe(60);
  });

  it('ignores handling time on an interval where nothing arrived', () => {
    const out = measureAccuracy([at('03:00', 5, 0, 240, 999)]);
    expect(out.ahtBiasSeconds).toBeNull();
  });
});

describe('saying what the numbers mean', () => {
  it('says plainly when there is nothing to measure', () => {
    expect(interpret(measureAccuracy([at('09:00', 100, null)]))[0]).toContain('No actual volume');
  });

  it('calls out a consistent shortfall as a shortfall', () => {
    const notes = interpret(measureAccuracy([at('09:00', 90, 100), at('09:30', 180, 200)]));
    expect(notes.join(' ')).toContain('low overall');
    expect(notes.join(' ')).toContain('floor was short');
  });

  it('calls out consistent over-forecasting the other way', () => {
    const notes = interpret(measureAccuracy([at('09:00', 110, 100), at('09:30', 220, 200)]));
    expect(notes.join(' ')).toContain('high overall');
  });

  it('says noise is noise when the error has no direction', () => {
    const notes = interpret(measureAccuracy([at('09:00', 90, 100), at('09:30', 110, 100)]));
    expect(notes.join(' ')).toContain('noise');
  });

  it('mentions handling time when it is materially off', () => {
    const notes = interpret(measureAccuracy([at('09:00', 100, 100, 240, 320)]));
    expect(notes.join(' ')).toContain('longer than planned');
  });

  it('stays quiet about handling time when it is close', () => {
    const notes = interpret(measureAccuracy([at('09:00', 100, 100, 240, 243)]));
    expect(notes.join(' ')).not.toContain('longer than planned');
  });

  it('counts the gaps so a good number on two intervals is not mistaken for a good week', () => {
    const notes = interpret(measureAccuracy([at('09:00', 100, 100), at('09:30', 100, null)]));
    expect(notes.join(' ')).toContain('1 interval has no actual recorded');
  });
});
