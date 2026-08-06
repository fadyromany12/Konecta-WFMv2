/**
 * Staffing mathematics — the planning half of workforce management.
 *
 * Timekeeping records what happened. This works out what *should* happen: given
 * a volume of contacts, how long they take and the service level promised to
 * the client, how many advisors need to be on the phone in each interval.
 *
 * The model is Erlang C, which assumes contacts arrive at random (Poisson),
 * are handled in a time that averages out to the AHT, and that callers queue
 * rather than abandon. Those assumptions are imperfect — real callers hang up,
 * and arrivals bunch — so the output is a planning figure to staff against, not
 * a promise. It is the standard the industry plans on because it is close
 * enough at interval level and cheap to compute.
 */

/** A half hour is the interval every contact centre plans in. */
export const INTERVAL_MINUTES = 30;

export interface StaffingInput {
  /** Contacts offered in the interval. */
  volume: number;
  /** Average handling time, seconds — talk plus after-call work. */
  ahtSeconds: number;
  /** Fraction of contacts to answer within targetSeconds, e.g. 0.8 for 80%. */
  serviceGoal: number;
  /** The service level answer threshold in seconds, e.g. 20. */
  targetSeconds: number;
  /**
   * Time an advisor is paid but unavailable — breaks, meetings, training,
   * absence. Required headcount is grossed up by this so the roster holds when
   * people step away.
   */
  shrinkage: number;
  intervalMinutes?: number;
}

export interface StaffingResult {
  /** Erlang load in the interval: the hours of work arriving per hour. */
  offeredLoad: number;
  /** Advisors needed on the phone to hit the goal, before shrinkage. */
  agentsOnPhone: number;
  /** Rostered headcount once shrinkage is added — what scheduling must fill. */
  requiredAgents: number;
  /** Service level actually achieved at agentsOnPhone, 0-1. */
  serviceLevel: number;
  /** Fraction of an advisor's time spent handling contacts, 0-1. */
  occupancy: number;
  /** Average speed of answer in seconds. */
  asaSeconds: number;
}

/**
 * Erlang B by the recursive form. Iterating avoids the factorials and huge
 * powers in the textbook expression, which overflow long before the agent
 * counts a real contact centre reaches.
 */
export function erlangB(load: number, servers: number): number {
  if (servers <= 0) return 1;
  let b = 1;
  for (let n = 1; n <= servers; n++) {
    b = (load * b) / (n + load * b);
  }
  return b;
}

/** Probability an arriving contact has to wait at all. */
export function erlangC(load: number, servers: number): number {
  if (servers <= load) return 1; // the queue never clears
  const b = erlangB(load, servers);
  const denominator = 1 - (load / servers) * (1 - b);
  if (denominator <= 0) return 1;
  return Math.min(1, b / denominator);
}

/** Fraction of contacts answered within the target. */
export function serviceLevel(
  load: number,
  servers: number,
  ahtSeconds: number,
  targetSeconds: number,
): number {
  if (servers <= load) return 0;
  if (ahtSeconds <= 0) return 1;
  const c = erlangC(load, servers);
  const decay = Math.exp((-(servers - load) * targetSeconds) / ahtSeconds);
  return Math.max(0, Math.min(1, 1 - c * decay));
}

/** Average seconds a contact waits before being answered. */
export function averageSpeedOfAnswer(load: number, servers: number, ahtSeconds: number): number {
  if (servers <= load) return Number.POSITIVE_INFINITY;
  return (erlangC(load, servers) * ahtSeconds) / (servers - load);
}

/**
 * Smallest number of advisors that meets the service goal, plus the figures a
 * planner reads alongside it. Occupancy is worth watching: a roster that hits
 * the service level at 95% occupancy will burn people out, and the metric is
 * there to make that visible rather than to be optimised.
 */
export function requiredStaffing(input: StaffingInput): StaffingResult {
  const intervalMinutes = input.intervalMinutes ?? INTERVAL_MINUTES;
  const intervalSeconds = intervalMinutes * 60;
  const shrinkage = clamp(input.shrinkage, 0, 0.95);

  if (input.volume <= 0 || input.ahtSeconds <= 0) {
    return {
      offeredLoad: 0,
      agentsOnPhone: 0,
      requiredAgents: 0,
      serviceLevel: 1,
      occupancy: 0,
      asaSeconds: 0,
    };
  }

  const offeredLoad = (input.volume * input.ahtSeconds) / intervalSeconds;
  const goal = clamp(input.serviceGoal, 0, 0.999);

  // Start just above the load — below it no number of agents clears the queue.
  let agents = Math.max(1, Math.floor(offeredLoad) + 1);
  const ceiling = Math.max(agents, Math.ceil(offeredLoad * 3) + 30);
  while (
    agents < ceiling &&
    serviceLevel(offeredLoad, agents, input.ahtSeconds, input.targetSeconds) < goal
  ) {
    agents++;
  }

  const achieved = serviceLevel(offeredLoad, agents, input.ahtSeconds, input.targetSeconds);

  return {
    offeredLoad: round(offeredLoad, 2),
    agentsOnPhone: agents,
    requiredAgents: Math.ceil(agents / (1 - shrinkage)),
    serviceLevel: round(achieved, 4),
    occupancy: round(offeredLoad / agents, 4),
    asaSeconds: round(averageSpeedOfAnswer(offeredLoad, agents, input.ahtSeconds), 1),
  };
}

/** Every interval start time in a day, as `HH:MM`. */
export function intervalsOfDay(intervalMinutes = INTERVAL_MINUTES): string[] {
  const out: string[] = [];
  for (let m = 0; m < 1440; m += intervalMinutes) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
}

export interface CoverageInterval {
  startTime: string;
  volume: number;
  requiredAgents: number;
  scheduledAgents: number;
  /** Positive means over-staffed, negative means short. */
  variance: number;
  serviceLevel: number;
  occupancy: number;
}

/**
 * What the schedule actually delivers against what the forecast asked for.
 * The service level shown is what the *scheduled* headcount achieves, which is
 * the number worth looking at — the required figure is by construction on goal.
 */
export function buildCoverage(params: {
  intervals: { startTime: string; volume: number; ahtSeconds: number }[];
  scheduledByInterval: Map<string, number>;
  serviceGoal: number;
  targetSeconds: number;
  shrinkage: number;
  intervalMinutes?: number;
}): CoverageInterval[] {
  const intervalMinutes = params.intervalMinutes ?? INTERVAL_MINUTES;
  return params.intervals.map((interval) => {
    const staffing = requiredStaffing({
      volume: interval.volume,
      ahtSeconds: interval.ahtSeconds,
      serviceGoal: params.serviceGoal,
      targetSeconds: params.targetSeconds,
      shrinkage: params.shrinkage,
      intervalMinutes,
    });
    const scheduled = params.scheduledByInterval.get(interval.startTime) ?? 0;
    const load = staffing.offeredLoad;
    // Scheduled headcount includes shrinkage; discount it back to a phone figure.
    const onPhone = Math.max(0, Math.round(scheduled * (1 - clamp(params.shrinkage, 0, 0.95))));

    return {
      startTime: interval.startTime,
      volume: interval.volume,
      requiredAgents: staffing.requiredAgents,
      scheduledAgents: scheduled,
      variance: scheduled - staffing.requiredAgents,
      serviceLevel:
        load <= 0
          ? 1
          : round(serviceLevel(load, onPhone, interval.ahtSeconds, params.targetSeconds), 4),
      occupancy: onPhone > 0 ? round(Math.min(1, load / onPhone), 4) : 0,
    };
  });
}

/** Day-level roll-up of a coverage curve. */
export function summariseCoverage(coverage: CoverageInterval[]) {
  const staffed = coverage.filter((c) => c.volume > 0);
  const understaffed = staffed.filter((c) => c.variance < 0);
  const totalVolume = staffed.reduce((sum, c) => sum + c.volume, 0);

  // Weight by volume: being short when nothing is arriving does not matter.
  const weightedServiceLevel =
    totalVolume > 0
      ? staffed.reduce((sum, c) => sum + c.serviceLevel * c.volume, 0) / totalVolume
      : 1;

  return {
    intervals: staffed.length,
    totalVolume: round(totalVolume, 0),
    requiredHours: round((staffed.reduce((s, c) => s + c.requiredAgents, 0) * INTERVAL_MINUTES) / 60, 1),
    scheduledHours: round((staffed.reduce((s, c) => s + c.scheduledAgents, 0) * INTERVAL_MINUTES) / 60, 1),
    understaffedIntervals: understaffed.length,
    worstVariance: understaffed.reduce((worst, c) => Math.min(worst, c.variance), 0),
    projectedServiceLevel: round(weightedServiceLevel, 4),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, places: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
