import { describe, expect, it } from 'vitest';
import { findGaps, findSurpluses, recommend } from '../rebalance.js';
import type { CoverageInterval } from '../forecast.js';

const iv = (
  startTime: string,
  variance: number,
  volume = 100,
  serviceLevel = 0.8,
): CoverageInterval => ({
  startTime,
  volume,
  requiredAgents: 10,
  scheduledAgents: 10 + variance,
  variance,
  serviceLevel,
  occupancy: 0.85,
});

describe('finding the holes', () => {
  it('groups consecutive short intervals into one run', () => {
    const gaps = findGaps([iv('09:00', 0), iv('09:30', -2), iv('10:00', -3), iv('10:30', 0)]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ from: '09:30', to: '10:00', intervals: 2, shortBy: 3, agentIntervals: 5 });
  });

  it('separates runs broken by a covered interval', () => {
    const gaps = findGaps([iv('09:00', -1), iv('09:30', 0), iv('10:00', -1)]);
    expect(gaps).toHaveLength(2);
  });

  it('ignores intervals nobody expects calls in', () => {
    // Night intervals with no volume must not report as the whole shift short.
    expect(findGaps([iv('03:00', -8, 0), iv('03:30', -8, 0)])).toEqual([]);
  });

  it('reports the worst run first, not the earliest', () => {
    const gaps = findGaps([iv('09:00', -1), iv('09:30', 0), iv('10:00', -5), iv('10:30', -5)]);
    expect(gaps[0].from).toBe('10:00');
    expect(gaps[0].agentIntervals).toBe(10);
  });

  it('keeps the worst service level reached inside a run', () => {
    const gaps = findGaps([iv('09:00', -1, 100, 0.72), iv('09:30', -1, 100, 0.41)]);
    expect(gaps[0].worstServiceLevel).toBeCloseTo(0.41, 6);
  });

  it('finds the spare capacity too', () => {
    const spare = findSurpluses([iv('09:00', 2), iv('09:30', 3), iv('10:00', -1)]);
    expect(spare).toHaveLength(1);
    expect(spare[0]).toMatchObject({ from: '09:00', to: '09:30', agentIntervals: 5 });
  });
});

describe('what to do about them', () => {
  it('moves a break before it buys an hour', () => {
    // Spare at 10:00, short at 10:30 — the cover exists, it is standing in the
    // wrong place.
    const out = recommend({
      coverage: [iv('10:00', 3), iv('10:30', -3)],
      availableForExtraHours: 10,
    });
    expect(out[0].kind).toBe('MOVE_BREAKS');
    expect(out[0].covers).toBe(3);
    expect(out.some((r) => r.kind === 'OFFER_EXTRA_HOURS')).toBe(false);
  });

  it('says the free option costs nothing, because that is the reason to prefer it', () => {
    const out = recommend({ coverage: [iv('10:00', 3), iv('10:30', -3)] });
    expect(out[0].detail).toContain('no cost');
  });

  it('buys only what moving cannot cover', () => {
    const out = recommend({
      coverage: [iv('10:00', 1), iv('10:30', -4)],
      availableForExtraHours: 10,
    });
    expect(out[0].kind).toBe('MOVE_BREAKS');
    expect(out[0].covers).toBe(1);
    expect(out[1].kind).toBe('OFFER_EXTRA_HOURS');
    // Three of the four remain.
    expect(out[1].covers).toBe(3);
  });

  it('will not move a break from six hours away', () => {
    const out = recommend({
      coverage: [iv('03:00', 5), iv('04:00', 0), iv('12:00', -2)],
      availableForExtraHours: 5,
    });
    expect(out.every((r) => r.kind !== 'MOVE_BREAKS')).toBe(true);
    expect(out[0].kind).toBe('OFFER_EXTRA_HOURS');
  });

  it('never offers the same spare person to two gaps', () => {
    // One surplus of 2, two separate gaps of 2 each.
    const out = recommend({
      coverage: [iv('09:00', -2), iv('09:30', 2), iv('10:00', -2)],
      availableForExtraHours: 0,
    });
    const moved = out.filter((r) => r.kind === 'MOVE_BREAKS').reduce((s, r) => s + r.covers, 0);
    expect(moved).toBe(2);
    // The rest has to show up as unfillable rather than quietly vanishing.
    expect(out.some((r) => r.kind === 'UNFILLABLE')).toBe(true);
  });

  it('says plainly when a gap cannot be closed', () => {
    const out = recommend({ coverage: [iv('14:00', -4, 100, 0.35)], availableForExtraHours: 0 });
    expect(out[0].kind).toBe('UNFILLABLE');
    expect(out[0].detail).toContain('35%');
    expect(out[0].detail).toContain('needs a decision');
  });

  it('caps an offer at the people who actually exist', () => {
    const out = recommend({ coverage: [iv('14:00', -6)], availableForExtraHours: 2 });
    const offer = out.find((r) => r.kind === 'OFFER_EXTRA_HOURS')!;
    expect(offer.people).toBe(2);
    expect(out.some((r) => r.kind === 'UNFILLABLE')).toBe(true);
  });

  it('recommends nothing at all when the day is covered', () => {
    expect(recommend({ coverage: [iv('09:00', 0), iv('09:30', 1)] })).toEqual([]);
  });

  it('counts people for a run, not for an interval', () => {
    // Two short across four intervals is eight agent-intervals, which two
    // people cover for the whole run — not eight people.
    const out = recommend({
      coverage: [iv('14:00', -2), iv('14:30', -2), iv('15:00', -2), iv('15:30', -2)],
      availableForExtraHours: 10,
    });
    const offer = out.find((r) => r.kind === 'OFFER_EXTRA_HOURS')!;
    expect(offer.gap.agentIntervals).toBe(8);
    expect(offer.people).toBe(2);
  });

  it('names the stretch to post, not each half hour separately', () => {
    const out = recommend({
      coverage: [iv('15:00', -1), iv('15:30', -1), iv('16:00', -1)],
      availableForExtraHours: 5,
    });
    expect(out).toHaveLength(1);
    // Runs to the end of the last interval, so an offer can be posted from the
    // headline without anybody having to add half an hour in their head.
    expect(out[0].headline).toContain('15:00–16:30');
  });

  it('writes a single interval as a real window rather than 15:30–15:30', () => {
    const out = recommend({ coverage: [iv('15:30', -2)], availableForExtraHours: 5 });
    expect(out[0].headline).toContain('15:30–16:00');
  });

  it('wraps past midnight without producing 24:00', () => {
    const out = recommend({ coverage: [iv('23:30', -2)], availableForExtraHours: 5 });
    expect(out[0].headline).toContain('23:30–00:00');
  });
});
