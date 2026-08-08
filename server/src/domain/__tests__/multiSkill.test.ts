import { describe, expect, it } from 'vitest';
import { planMultiSkill, simulateSkills } from '../multiSkill.js';
import { requiredStaffing, serviceLevel } from '../forecast.js';

/**
 * The load-bearing test in this file is the first one.
 *
 * A simulation of a multi-skill centre has nothing to check itself against —
 * that is the whole reason it exists. But collapse it to one skill and one
 * pool and it becomes an M/M/c queue, which Erlang C answers exactly. If the
 * simulation cannot recover the closed form there, every multi-skill number it
 * produces is worthless, and nothing else in this file would notice.
 */

const SKILL = (key: string, volume: number, ahtSeconds = 240) => ({ key, volume, ahtSeconds });

describe('the simulation agrees with Erlang C where Erlang C is right', () => {
  it('reproduces the closed-form service level for a single pooled queue', () => {
    const volume = 100;
    const aht = 240;
    const agents = 15;
    const targetSeconds = 20;

    const load = (volume * aht) / (30 * 60);
    const closedForm = serviceLevel(load, agents, aht, targetSeconds);

    const simulated = simulateSkills(
      [SKILL('all', volume, aht)],
      [{ key: 'everyone', skills: ['all'], agents }],
      { targetSeconds, replications: 60, seed: 7 },
    );

    // Sampling error over sixty half hours, not a fudge factor: the two are
    // estimating the same quantity and must land within a few points.
    expect(simulated.perSkill[0].serviceLevel).toBeGreaterThan(closedForm - 0.06);
    expect(simulated.perSkill[0].serviceLevel).toBeLessThan(closedForm + 0.06);
  });

  it('reproduces the closed form at a different load', () => {
    const volume = 60;
    const aht = 300;
    const agents = 12;
    const load = (volume * aht) / (30 * 60);
    const closedForm = serviceLevel(load, agents, aht, 30);

    const simulated = simulateSkills(
      [SKILL('all', volume, aht)],
      [{ key: 'everyone', skills: ['all'], agents }],
      { targetSeconds: 30, replications: 60, seed: 11 },
    );
    expect(Math.abs(simulated.perSkill[0].serviceLevel - closedForm)).toBeLessThan(0.06);
  });

  it('sizes a single-skill roster close to what Erlang C demands', () => {
    const closed = requiredStaffing({
      volume: 80,
      ahtSeconds: 240,
      serviceGoal: 0.8,
      targetSeconds: 20,
      shrinkage: 0,
    });
    const plan = planMultiSkill({
      skills: [SKILL('all', 80)],
      pools: [{ key: 'everyone', skills: ['all'] }],
      serviceGoal: 0.8,
      targetSeconds: 20,
      shrinkage: 0,
      replications: 40,
    });
    expect(Math.abs(plan.agentsOnPhone - closed.agentsOnPhone)).toBeLessThanOrEqual(2);
  });
});

describe('what having separate skills actually costs', () => {
  it('needs more people split across two skills than pooled into one', () => {
    // The same total traffic. Splitting it removes the pooling benefit, and
    // the requirement has to go up — this is the error the old single-queue
    // model was making, and its direction is the point.
    const split = planMultiSkill({
      skills: [SKILL('en', 50), SKILL('ar', 50)],
      pools: [
        { key: 'english', skills: ['en'] },
        { key: 'arabic', skills: ['ar'] },
      ],
      serviceGoal: 0.8,
      targetSeconds: 20,
      shrinkage: 0,
      replications: 30,
    });
    expect(split.agentsOnPhone).toBeGreaterThan(split.pooledEquivalent);
  });

  it('cross-training recovers some of what splitting cost', () => {
    const rigid = planMultiSkill({
      skills: [SKILL('en', 50), SKILL('ar', 50)],
      pools: [
        { key: 'english', skills: ['en'] },
        { key: 'arabic', skills: ['ar'] },
      ],
      serviceGoal: 0.8,
      targetSeconds: 20,
      shrinkage: 0,
      replications: 30,
    });
    const flexible = planMultiSkill({
      skills: [SKILL('en', 50), SKILL('ar', 50)],
      pools: [{ key: 'both', skills: ['en', 'ar'] }],
      serviceGoal: 0.8,
      targetSeconds: 20,
      shrinkage: 0,
      replications: 30,
    });
    expect(flexible.agentsOnPhone).toBeLessThanOrEqual(rigid.agentsOnPhone);
  });

  it('reports both bounds so the number can be placed against them', () => {
    const plan = planMultiSkill({
      skills: [SKILL('en', 40), SKILL('ar', 40)],
      pools: [
        { key: 'english', skills: ['en'] },
        { key: 'arabic', skills: ['ar'] },
      ],
      serviceGoal: 0.8,
      targetSeconds: 20,
      shrinkage: 0,
      replications: 20,
    });
    // Fully isolated is the pessimistic bound, fully pooled the optimistic one.
    expect(plan.isolatedEquivalent).toBeGreaterThan(plan.pooledEquivalent);
  });
});

describe('the routing rules', () => {
  it('keeps a skill with no one trained on it unanswered', () => {
    const result = simulateSkills(
      [SKILL('en', 40), SKILL('ar', 40)],
      [{ key: 'english', skills: ['en'], agents: 20 }],
      { targetSeconds: 20, replications: 10, seed: 3 },
    );
    const arabic = result.perSkill.find((s) => s.key === 'ar')!;
    expect(arabic.answered).toBe(0);
    expect(arabic.serviceLevel).toBe(0);
    // And the plan's verdict is driven by the skill that fails, not the average.
    expect(result.worstServiceLevel).toBe(0);
  });

  it('does not count a skill with no traffic as a failure', () => {
    const result = simulateSkills(
      [SKILL('en', 40), SKILL('ar', 0)],
      [{ key: 'english', skills: ['en'], agents: 12 }],
      { targetSeconds: 20, replications: 10, seed: 3 },
    );
    expect(result.worstServiceLevel).toBeGreaterThan(0);
  });

  it('is deterministic — the same inputs give the same answer', () => {
    const run = () =>
      simulateSkills(
        [SKILL('en', 50), SKILL('ar', 30)],
        [
          { key: 'english', skills: ['en'], agents: 8 },
          { key: 'both', skills: ['en', 'ar'], agents: 5 },
        ],
        { targetSeconds: 20, replications: 12, seed: 42 },
      );
    expect(run()).toEqual(run());
  });

  it('applies shrinkage on top of the simulated requirement', () => {
    const plan = planMultiSkill({
      skills: [SKILL('all', 60)],
      pools: [{ key: 'everyone', skills: ['all'] }],
      serviceGoal: 0.8,
      targetSeconds: 20,
      shrinkage: 0.3,
      replications: 20,
    });
    expect(plan.requiredAgents).toBe(Math.ceil(plan.agentsOnPhone / 0.7));
  });

  it('returns nothing to staff when nothing arrives', () => {
    const plan = planMultiSkill({
      skills: [SKILL('all', 0)],
      pools: [{ key: 'everyone', skills: ['all'] }],
      serviceGoal: 0.8,
      targetSeconds: 20,
      shrinkage: 0.3,
    });
    expect(plan.agentsOnPhone).toBe(0);
    expect(plan.requiredAgents).toBe(0);
  });

  it('gives up rather than looping when a goal cannot be met', () => {
    // Nobody is trained on Arabic, so no headcount ever meets the goal.
    const plan = planMultiSkill({
      skills: [SKILL('en', 30), SKILL('ar', 30)],
      pools: [{ key: 'english', skills: ['en'] }],
      serviceGoal: 0.9,
      targetSeconds: 20,
      shrinkage: 0,
      replications: 8,
    });
    expect(plan.capped).toBe(true);
  });
});
