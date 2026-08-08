import { describe, expect, it } from 'vitest';
import { leaveImpact, summariseLeaveImpact } from '../leaveImpact.js';
import type { CoverageInterval } from '../forecast.js';

/**
 * The rule these cover: approving leave should tell the supervisor what it
 * costs, and should only claim a cost where one genuinely exists.
 */
function interval(
  startTime: string,
  scheduledAgents: number,
  requiredAgents: number,
  volume = 20,
): CoverageInterval {
  return {
    startTime,
    volume,
    requiredAgents,
    scheduledAgents,
    variance: scheduledAgents - requiredAgents,
    serviceLevel: 0.85,
    occupancy: 0.7,
  };
}

const COVERS = (...times: string[]) => new Set(times);

describe('what approving leave costs', () => {
  it('says nothing is lost when the day stays covered', () => {
    const result = leaveImpact({
      date: '2025-06-12',
      coverage: [interval('09:00', 6, 4), interval('09:30', 6, 4)],
      coveredIntervals: COVERS('09:00', '09:30'),
    });
    expect(result.severity).toBe('none');
    expect(result.newlyShortIntervals).toBe(0);
    expect(result.summary).toContain('stays covered');
  });

  it('reports an interval that goes short only because of the leave', () => {
    const result = leaveImpact({
      date: '2025-06-12',
      coverage: [interval('09:00', 4, 4)],
      coveredIntervals: COVERS('09:00'),
      advisorName: 'Layla',
    });
    expect(result.newlyShortIntervals).toBe(1);
    expect(result.severity).toBe('watch');
    expect(result.summary).toContain('09:00');
  });

  it('does not blame the leave for an interval that was already short', () => {
    // Two under before, three under after. Worth saying, but it is not this
    // request that broke the day and the wording must not imply it did.
    const result = leaveImpact({
      date: '2025-06-12',
      coverage: [interval('09:00', 2, 4)],
      coveredIntervals: COVERS('09:00'),
    });
    expect(result.newlyShortIntervals).toBe(0);
    expect(result.worsenedIntervals).toBe(1);
    expect(result.summary).toContain('already short');
  });

  it('ignores intervals the advisor was not covering', () => {
    // Rostered 09:00 only. The 14:00 gap is somebody else's problem and must
    // not be attributed to this request.
    const result = leaveImpact({
      date: '2025-06-12',
      coverage: [interval('09:00', 6, 4), interval('14:00', 4, 4)],
      coveredIntervals: COVERS('09:00'),
    });
    expect(result.affectedIntervals).toBe(1);
    expect(result.newlyShortIntervals).toBe(0);
  });

  it('ignores intervals with no forecast volume', () => {
    // Losing a body at 03:00 when nothing is arriving is not a coverage cost.
    const result = leaveImpact({
      date: '2025-06-12',
      coverage: [interval('03:00', 1, 0, 0)],
      coveredIntervals: COVERS('03:00'),
    });
    expect(result.severity).toBe('none');
    expect(result.newlyShortIntervals).toBe(0);
  });

  it('escalates when several intervals go short', () => {
    const result = leaveImpact({
      date: '2025-06-12',
      coverage: [interval('09:00', 4, 4), interval('09:30', 4, 4), interval('10:00', 4, 4)],
      coveredIntervals: COVERS('09:00', '09:30', '10:00'),
    });
    expect(result.newlyShortIntervals).toBe(3);
    expect(result.severity).toBe('high');
  });

  it('escalates when one interval goes badly short', () => {
    const result = leaveImpact({
      date: '2025-06-12',
      coverage: [interval('09:00', 4, 5)],
      coveredIntervals: COVERS('09:00'),
    });
    // Already one under, two under afterwards.
    expect(result.worst?.variance).toBe(-2);
    expect(result.severity).toBe('high');
  });

  it('never lets cover go below zero', () => {
    const result = leaveImpact({
      date: '2025-06-12',
      coverage: [interval('09:00', 0, 2)],
      coveredIntervals: COVERS('09:00'),
    });
    expect(result.intervals[0].after).toBe(0);
  });
});

describe('rolling several days into one line', () => {
  const clean = leaveImpact({
    date: '2025-06-12',
    coverage: [interval('09:00', 6, 4)],
    coveredIntervals: COVERS('09:00'),
  });
  const bad = leaveImpact({
    date: '2025-06-13',
    coverage: [interval('09:00', 4, 4), interval('09:30', 4, 4), interval('10:00', 4, 4)],
    coveredIntervals: COVERS('09:00', '09:30', '10:00'),
  });

  it('says so plainly when every day holds', () => {
    const rolled = summariseLeaveImpact([clean, clean]);
    expect(rolled.severity).toBe('none');
    expect(rolled.summary).toContain('stay covered');
  });

  it('takes the worst day as the verdict', () => {
    const rolled = summariseLeaveImpact([clean, bad]);
    expect(rolled.severity).toBe('high');
    expect(rolled.newlyShortIntervals).toBe(3);
    expect(rolled.summary).toContain('1 of 2 days');
  });

  it('does not pluralise a single day into a range', () => {
    const rolled = summariseLeaveImpact([bad]);
    expect(rolled.summary).toBe(bad.summary);
  });
});
