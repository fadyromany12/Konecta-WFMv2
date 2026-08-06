import { describe, expect, it } from 'vitest';
import {
  averageSpeedOfAnswer,
  buildCoverage,
  erlangB,
  erlangC,
  intervalsOfDay,
  requiredStaffing,
  serviceLevel,
  summariseCoverage,
} from '../forecast.js';

describe('erlang formulas', () => {
  it('matches the published Erlang B figure for a small system', () => {
    // A = 2 erlangs over 3 servers gives a blocking probability of 4/19.
    expect(erlangB(2, 3)).toBeCloseTo(0.2105, 3);
  });

  it('returns certainty of waiting when the load exceeds the servers', () => {
    expect(erlangC(10, 8)).toBe(1);
    expect(serviceLevel(10, 8, 180, 20)).toBe(0);
  });

  it('waits less as staffing rises above the load', () => {
    const light = averageSpeedOfAnswer(8, 12, 180);
    const heavy = averageSpeedOfAnswer(8, 9, 180);
    expect(light).toBeLessThan(heavy);
  });

  it('stays numerically sound at the agent counts a real centre reaches', () => {
    // The textbook A^N/N! form overflows here; the recursive one does not.
    const c = erlangC(300, 320);
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(1);
  });
});

describe('required staffing', () => {
  const base = {
    volume: 100,
    ahtSeconds: 240,
    serviceGoal: 0.8,
    targetSeconds: 20,
    shrinkage: 0,
  };

  it('computes the offered load from volume and handling time', () => {
    // 100 contacts of 240s in a 1800s interval is 13.33 erlangs.
    expect(requiredStaffing(base).offeredLoad).toBeCloseTo(13.33, 1);
  });

  it('staffs above the offered load and meets the goal', () => {
    const result = requiredStaffing(base);
    expect(result.agentsOnPhone).toBeGreaterThan(result.offeredLoad);
    expect(result.serviceLevel).toBeGreaterThanOrEqual(0.8);
  });

  it('does not overstaff — one fewer agent would miss the goal', () => {
    const result = requiredStaffing(base);
    const oneFewer = serviceLevel(result.offeredLoad, result.agentsOnPhone - 1, base.ahtSeconds, 20);
    expect(oneFewer).toBeLessThan(0.8);
  });

  it('needs more people for a tighter service goal', () => {
    const relaxed = requiredStaffing({ ...base, serviceGoal: 0.7, targetSeconds: 60 });
    const strict = requiredStaffing({ ...base, serviceGoal: 0.95, targetSeconds: 10 });
    expect(strict.agentsOnPhone).toBeGreaterThan(relaxed.agentsOnPhone);
  });

  it('grosses the roster up for shrinkage', () => {
    const none = requiredStaffing(base);
    const third = requiredStaffing({ ...base, shrinkage: 0.3 });
    expect(third.agentsOnPhone).toBe(none.agentsOnPhone);
    expect(third.requiredAgents).toBe(Math.ceil(none.agentsOnPhone / 0.7));
  });

  it('reports occupancy so an unsustainable roster is visible', () => {
    const result = requiredStaffing(base);
    expect(result.occupancy).toBeGreaterThan(0);
    expect(result.occupancy).toBeLessThan(1);
  });

  it('asks for nobody when nothing is forecast', () => {
    const quiet = requiredStaffing({ ...base, volume: 0 });
    expect(quiet.requiredAgents).toBe(0);
    expect(quiet.serviceLevel).toBe(1);
  });

  it('scales sub-linearly — double the volume needs less than double the staff', () => {
    // The pooling effect, and the reason big queues are cheaper per contact.
    const single = requiredStaffing(base);
    const double = requiredStaffing({ ...base, volume: 200 });
    expect(double.agentsOnPhone).toBeLessThan(single.agentsOnPhone * 2);
  });
});

describe('coverage', () => {
  const intervals = [
    { startTime: '09:00', volume: 100, ahtSeconds: 240 },
    { startTime: '09:30', volume: 40, ahtSeconds: 240 },
    { startTime: '10:00', volume: 0, ahtSeconds: 240 },
  ];

  it('reports the gap between what is scheduled and what is needed', () => {
    const coverage = buildCoverage({
      intervals,
      scheduledByInterval: new Map([['09:00', 5], ['09:30', 30]]),
      serviceGoal: 0.8,
      targetSeconds: 20,
      shrinkage: 0.3,
    });
    expect(coverage[0].variance).toBeLessThan(0); // badly short at the peak
    expect(coverage[1].variance).toBeGreaterThan(0); // over-covered after it
  });

  it('projects a poor service level where it is short', () => {
    const coverage = buildCoverage({
      intervals,
      scheduledByInterval: new Map([['09:00', 5]]),
      serviceGoal: 0.8,
      targetSeconds: 20,
      shrinkage: 0.3,
    });
    expect(coverage[0].serviceLevel).toBeLessThan(0.8);
  });

  it('ignores intervals with no volume when summarising', () => {
    const coverage = buildCoverage({
      intervals,
      scheduledByInterval: new Map([['09:00', 25], ['09:30', 12]]),
      serviceGoal: 0.8,
      targetSeconds: 20,
      shrinkage: 0.3,
    });
    const summary = summariseCoverage(coverage);
    expect(summary.intervals).toBe(2);
    expect(summary.totalVolume).toBe(140);
  });

  it('weights the projected service level by volume', () => {
    // Short in a quiet interval should barely move the day's number.
    const coverage = buildCoverage({
      intervals: [
        { startTime: '09:00', volume: 500, ahtSeconds: 240 },
        { startTime: '09:30', volume: 2, ahtSeconds: 240 },
      ],
      scheduledByInterval: new Map([['09:00', 130], ['09:30', 1]]),
      serviceGoal: 0.8,
      targetSeconds: 20,
      shrinkage: 0.3,
    });
    expect(summariseCoverage(coverage).projectedServiceLevel).toBeGreaterThan(0.8);
  });
});

describe('interval grid', () => {
  it('covers the day in half hours', () => {
    const grid = intervalsOfDay();
    expect(grid).toHaveLength(48);
    expect(grid[0]).toBe('00:00');
    expect(grid[19]).toBe('09:30');
    expect(grid[47]).toBe('23:30');
  });
});
