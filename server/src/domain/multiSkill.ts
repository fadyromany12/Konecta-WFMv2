/**
 * Staffing when advisors are not interchangeable.
 *
 * Erlang C answers one queue served by identical agents. Almost no real
 * contact centre is that. There is a Arabic-language queue and an English one,
 * a billing skill and a technical skill, and a handful of people who can take
 * both — and the tool has been telling planners "the model assumes a single
 * queue; treat the requirement as optimistic". That caveat is honest but it is
 * not an answer, and the error runs the wrong way: it under-staffs, because
 * pooling benefits the model assumes are not there in the building.
 *
 * The two closed forms available are both wrong in known directions. Sizing
 * each skill as its own Erlang C is pessimistic — it throws away the pooling
 * that the cross-trained people genuinely provide. Sizing everything as one
 * queue is optimistic, which is what we have. Interpolating between them would
 * be a number with no meaning.
 *
 * So this simulates instead. Poisson arrivals, exponential handling and
 * skill-based routing, run with a seeded generator so the same inputs give the
 * same answer every time — a planner who reloads and sees a different
 * requirement stops trusting the tool, and reproducibility matters more here
 * than the last decimal.
 *
 * The property that keeps it honest: with one skill and one pool this must
 * reproduce Erlang C, and the tests assert exactly that. A simulation that
 * cannot recover the closed form where the closed form is right has a bug in
 * it somewhere, and it would be invisible in the multi-skill case where there
 * is nothing to check against.
 */

import { INTERVAL_MINUTES, requiredStaffing, serviceLevel } from './forecast.js';

export interface Skill {
  key: string;
  /** Contacts arriving in the interval. */
  volume: number;
  ahtSeconds: number;
}

export interface Pool {
  key: string;
  /** Skill keys this pool can handle. A pool with several is cross-trained. */
  skills: string[];
  agents: number;
}

export interface SkillResult {
  key: string;
  serviceLevel: number;
  asaSeconds: number;
  /** Contacts that were answered within the run. */
  answered: number;
}

export interface SimulationResult {
  perSkill: SkillResult[];
  /** Occupancy of each pool, 0-1. */
  perPool: { key: string; occupancy: number; agents: number }[];
  /** The worst skill's service level — the one that decides whether a plan works. */
  worstServiceLevel: number;
  overallServiceLevel: number;
}

/**
 * Deterministic generator. `Math.random` would make every reload disagree with
 * the last, which for a planning number is worse than being slightly wrong.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const exponential = (rand: () => number, mean: number): number => -Math.log(1 - rand()) * mean;

interface Waiting {
  skill: number;
  arrivedAt: number;
}

interface Agent {
  pool: number;
  /** Skill indices this agent can serve, most specialised pools listed first. */
  skills: number[];
  freeAt: number;
  busySeconds: number;
}

export interface SimulationOptions {
  intervalMinutes?: number;
  targetSeconds: number;
  seed?: number;
  /**
   * Independent runs averaged together. One run of a half hour is a small
   * sample and its service level swings several points between seeds; the
   * default is enough to settle that without making the search slow.
   */
  replications?: number;
}

/**
 * One interval of skill-based routing, replicated and averaged.
 *
 * Two routing rules, both standard and both material:
 *
 * - An arriving contact takes the *least flexible* idle agent that can serve
 *   it, so the cross-trained people stay free for the queue that has nobody
 *   else. Taking any idle agent instead loses most of the value of having
 *   trained them.
 * - A freeing agent takes the longest-waiting contact among the skills it
 *   serves, so no queue is starved by a busier neighbour.
 */
export function simulateSkills(
  skills: Skill[],
  pools: Pool[],
  options: SimulationOptions,
): SimulationResult {
  const intervalSeconds = (options.intervalMinutes ?? INTERVAL_MINUTES) * 60;
  const replications = Math.max(1, options.replications ?? 24);
  const skillIndex = new Map(skills.map((s, i) => [s.key, i]));

  const totals = skills.map(() => ({ within: 0, waitSum: 0, answered: 0, arrived: 0 }));
  const poolBusy = pools.map(() => 0);

  for (let rep = 0; rep < replications; rep++) {
    const rand = mulberry32((options.seed ?? 1) * 7919 + rep * 104729);

    // Agents, ordered so that the least flexible are chosen first.
    const agents: Agent[] = [];
    pools.forEach((pool, p) => {
      const served = pool.skills
        .map((k) => skillIndex.get(k))
        .filter((i): i is number => i !== undefined);
      for (let a = 0; a < pool.agents; a++) {
        agents.push({ pool: p, skills: served, freeAt: 0, busySeconds: 0 });
      }
    });
    agents.sort((a, b) => a.skills.length - b.skills.length);
    if (agents.length === 0) continue;

    // Which skills anybody can actually take. A contact for a skill nobody is
    // trained on can never be served, and queueing it would leave the event
    // loop with work it can never clear — the queue never empties, no agent
    // ever frees, and the clock stops advancing. Counted as arrived and
    // unanswered instead, which is also what happens in the building.
    const servable = new Set<number>();
    for (const agent of agents) for (const s of agent.skills) servable.add(s);

    const warmup = intervalSeconds;
    const horizon = warmup + intervalSeconds;
    const arrivals: Waiting[] = [];
    skills.forEach((skill, s) => {
      if (skill.volume <= 0) return;
      const meanGap = intervalSeconds / skill.volume;
      let t = exponential(rand, meanGap);
      while (t < horizon) {
        if (servable.has(s)) arrivals.push({ skill: s, arrivedAt: t });
        else if (t >= warmup) totals[s].arrived++;
        t += exponential(rand, meanGap);
      }
    });
    arrivals.sort((a, b) => a.arrivedAt - b.arrivedAt);

    const queue: Waiting[] = [];
    let next = 0;
    let clock = 0;

    while (next < arrivals.length || queue.length > 0) {
      // Earliest moment anything can happen: the next arrival, or the next
      // agent to come free. Scanned rather than spread into Math.min, which
      // allocates an array on every event and dominated the run time.
      // Only agents still busy can change anything by becoming free. An idle
      // agent whose freeAt is in the past is not a future event, and treating
      // it as one pinned the clock: nothing in the queue was servable by it,
      // no time passed, and the loop spun.
      let nextFree = Infinity;
      if (queue.length > 0) {
        for (const agent of agents) {
          if (agent.freeAt > clock && agent.freeAt < nextFree) nextFree = agent.freeAt;
        }
      }
      const nextArrival = next < arrivals.length ? arrivals[next].arrivedAt : Infinity;
      const when = Math.min(nextArrival, nextFree);
      if (!Number.isFinite(when)) break;
      clock = Math.max(clock, when);

      if (nextArrival <= nextFree) {
        queue.push(arrivals[next]);
        next++;
      }

      for (const agent of agents) {
        if (queue.length === 0) break;
        if (agent.freeAt > clock) continue;
        const pick = queue.findIndex((w) => agent.skills.includes(w.skill));
        if (pick === -1) continue;
        const contact = queue.splice(pick, 1)[0];
        const wait = clock - contact.arrivedAt;
        const handling = exponential(rand, skills[contact.skill].ahtSeconds);
        agent.freeAt = clock + handling;

        // Only the measured window counts, so the warm-up cannot flatter the
        // result by answering an empty queue instantly.
        if (contact.arrivedAt >= warmup) {
          const t = totals[contact.skill];
          t.answered++;
          t.arrived++;
          t.waitSum += wait;
          if (wait <= options.targetSeconds) t.within++;
          agent.busySeconds += handling;
        }
      }
    }

    agents.forEach((agent) => {
      poolBusy[agent.pool] += agent.busySeconds;
    });
  }

  const perSkill: SkillResult[] = skills.map((skill, i) => {
    const t = totals[i];
    return {
      key: skill.key,
      // Measured against everything that arrived, not everything that was
      // answered. A skill nobody is trained on answers none of its contacts,
      // and dividing by what it answered would score that as a perfect zero
      // over zero rather than the total failure it is.
      serviceLevel: t.arrived === 0 ? 1 : t.within / t.arrived,
      asaSeconds: t.answered === 0 ? 0 : t.waitSum / t.answered,
      answered: Math.round(t.answered / replications),
    };
  });

  const perPool = pools.map((pool, p) => ({
    key: pool.key,
    agents: pool.agents,
    occupancy:
      pool.agents === 0 ? 0 : poolBusy[p] / (pool.agents * intervalSeconds * replications),
  }));

  const withDemand = perSkill.filter((_, i) => skills[i].volume > 0);
  const answered = withDemand.reduce((sum, s) => sum + s.answered, 0);

  return {
    perSkill,
    perPool,
    worstServiceLevel: withDemand.length === 0 ? 1 : Math.min(...withDemand.map((s) => s.serviceLevel)),
    overallServiceLevel:
      answered === 0
        ? 1
        : withDemand.reduce((sum, s) => sum + s.serviceLevel * s.answered, 0) / answered,
  };
}

export interface MultiSkillPlan {
  pools: { key: string; agents: number; occupancy: number }[];
  perSkill: SkillResult[];
  worstServiceLevel: number;
  overallServiceLevel: number;
  /** Total on the phone, before shrinkage. */
  agentsOnPhone: number;
  /** Rostered headcount once shrinkage is applied. */
  requiredAgents: number;
  /** What a single-queue Erlang C would have claimed, for comparison. */
  pooledEquivalent: number;
  /** What sizing each skill separately would have demanded. */
  isolatedEquivalent: number;
  /** True when the goal could not be met inside the search ceiling. */
  capped: boolean;
}

/**
 * Size a multi-skill roster: the smallest headcount per pool that meets the
 * goal on *every* skill.
 *
 * Greedy rather than exhaustive. The search space is one dimension per pool
 * and evaluating a point costs a simulation, so enumerating it is out. Instead
 * it starts from a floor that cannot possibly be enough, then repeatedly adds
 * one agent to whichever pool most improves the worst-served skill. That is a
 * hill climb and can in principle stop above the true optimum; in exchange it
 * terminates in a predictable number of simulations and never returns a plan
 * that misses the goal, which is the direction a planner can live with.
 *
 * The two closed-form bounds are returned alongside, unused by the search.
 * They are what makes the number legible: a planner who has been sizing on
 * pooled Erlang C for years needs to see how far this sits from the figure
 * they know, and in which direction.
 */
export function planMultiSkill(params: {
  skills: Skill[];
  /** Pools with their skill sets. The `agents` on each is ignored — this sizes them. */
  pools: { key: string; skills: string[] }[];
  serviceGoal: number;
  targetSeconds: number;
  shrinkage: number;
  intervalMinutes?: number;
  seed?: number;
  replications?: number;
}): MultiSkillPlan {
  const { skills, serviceGoal, targetSeconds, shrinkage } = params;
  const intervalMinutes = params.intervalMinutes ?? INTERVAL_MINUTES;
  const options: SimulationOptions = {
    intervalMinutes,
    targetSeconds,
    seed: params.seed ?? 1,
    replications: params.replications,
  };

  const totalVolume = skills.reduce((sum, s) => sum + s.volume, 0);
  if (totalVolume <= 0 || params.pools.length === 0) {
    return {
      pools: params.pools.map((p) => ({ key: p.key, agents: 0, occupancy: 0 })),
      perSkill: skills.map((s) => ({ key: s.key, serviceLevel: 1, asaSeconds: 0, answered: 0 })),
      worstServiceLevel: 1,
      overallServiceLevel: 1,
      agentsOnPhone: 0,
      requiredAgents: 0,
      pooledEquivalent: 0,
      isolatedEquivalent: 0,
      capped: false,
    };
  }

  // The two bounds, computed from the closed form.
  const weightedAht =
    skills.reduce((sum, s) => sum + s.volume * s.ahtSeconds, 0) / Math.max(1, totalVolume);
  const pooledEquivalent = requiredStaffing({
    volume: totalVolume,
    ahtSeconds: weightedAht,
    serviceGoal,
    targetSeconds,
    shrinkage: 0,
    intervalMinutes,
  }).agentsOnPhone;

  const isolatedEquivalent = skills
    .filter((s) => s.volume > 0)
    .reduce(
      (sum, s) =>
        sum +
        requiredStaffing({
          volume: s.volume,
          ahtSeconds: s.ahtSeconds,
          serviceGoal,
          targetSeconds,
          shrinkage: 0,
          intervalMinutes,
        }).agentsOnPhone,
      0,
    );

  // Start below the pooled figure — it is a lower bound on what any skill
  // arrangement needs, so starting there saves a dozen simulations without
  // risking a start above the answer.
  const counts = new Map<string, number>(params.pools.map((p) => [p.key, 0]));
  let seeded = Math.max(0, pooledEquivalent - 1);
  while (seeded > 0) {
    for (const pool of params.pools) {
      if (seeded === 0) break;
      counts.set(pool.key, counts.get(pool.key)! + 1);
      seeded--;
    }
  }

  const evaluate = (): SimulationResult =>
    simulateSkills(
      skills,
      params.pools.map((p) => ({ ...p, agents: counts.get(p.key)! })),
      options,
    );

  let result = evaluate();
  // Generous, but bounded: without a ceiling a goal that cannot be met at any
  // headcount would loop until the request timed out.
  const ceiling = Math.max(isolatedEquivalent * 2, pooledEquivalent * 3, 20);
  let capped = false;

  while (result.worstServiceLevel < serviceGoal) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total >= ceiling) {
      capped = true;
      break;
    }

    // Add one agent wherever it does the worst-served skill the most good.
    let best: { key: string; outcome: SimulationResult } | null = null;
    for (const pool of params.pools) {
      counts.set(pool.key, counts.get(pool.key)! + 1);
      const outcome = evaluate();
      counts.set(pool.key, counts.get(pool.key)! - 1);
      if (
        !best ||
        outcome.worstServiceLevel > best.outcome.worstServiceLevel ||
        (outcome.worstServiceLevel === best.outcome.worstServiceLevel &&
          outcome.overallServiceLevel > best.outcome.overallServiceLevel)
      ) {
        best = { key: pool.key, outcome };
      }
    }
    if (!best) break;
    counts.set(best.key, counts.get(best.key)! + 1);
    result = best.outcome;
  }

  const agentsOnPhone = [...counts.values()].reduce((a, b) => a + b, 0);
  const usableShrinkage = Math.min(Math.max(shrinkage, 0), 0.95);

  return {
    pools: params.pools.map((p) => ({
      key: p.key,
      agents: counts.get(p.key)!,
      occupancy: result.perPool.find((x) => x.key === p.key)?.occupancy ?? 0,
    })),
    perSkill: result.perSkill,
    worstServiceLevel: result.worstServiceLevel,
    overallServiceLevel: result.overallServiceLevel,
    agentsOnPhone,
    requiredAgents: Math.ceil(agentsOnPhone / (1 - usableShrinkage)),
    pooledEquivalent,
    isolatedEquivalent,
    capped,
  };
}

/**
 * The closed-form service level for a single pooled queue, exposed so callers
 * can show what the old assumption would have claimed without reaching into
 * the Erlang module themselves.
 */
export function pooledServiceLevel(params: {
  volume: number;
  ahtSeconds: number;
  agents: number;
  targetSeconds: number;
  intervalMinutes?: number;
}): number {
  const intervalSeconds = (params.intervalMinutes ?? INTERVAL_MINUTES) * 60;
  const load = (params.volume * params.ahtSeconds) / intervalSeconds;
  return serviceLevel(load, params.agents, params.ahtSeconds, params.targetSeconds);
}
