/**
 * Turning a coverage curve into something to do about it.
 *
 * The live board already showed a supervisor that 15:00 was four short. What
 * it never did was say what to do, so every afternoon somebody worked out the
 * same answer from the same three screens.
 *
 * The order of the recommendations is the point, and it is the order a WFM
 * analyst actually works in:
 *
 * 1. **Move a break.** If the short interval sits next to a surplus one, the
 *    cover already exists and is simply standing in the wrong place. This costs
 *    nothing at all, and it is the first thing anyone competent tries. A tool
 *    that leads with "offer extra hours" is a tool that spends money to solve a
 *    problem it could have moved.
 * 2. **Offer extra hours** to people who are off, for what is left.
 * 3. **Say it cannot be closed** when it cannot. A recommendation nobody can
 *    act on is worse than silence, because it teaches people to stop reading.
 *
 * Everything here is arithmetic on a curve. Who is actually available is a
 * database question and lives in the service.
 */

import type { CoverageInterval } from './forecast.js';

export interface Gap {
  /** First and last interval of a contiguous run that is short. */
  from: string;
  to: string;
  intervals: number;
  /** The worst single-interval shortfall in the run. */
  shortBy: number;
  /**
   * Total agent-intervals missing. This, not `shortBy`, is what an offer has to
   * cover: two people short for four intervals is eight, and a single person
   * accepting two hours fills it.
   */
  agentIntervals: number;
  /** The lowest service level reached inside the run. */
  worstServiceLevel: number;
}

export interface Surplus {
  from: string;
  to: string;
  intervals: number;
  /** Spare agent-intervals available to move. */
  agentIntervals: number;
}

/**
 * Runs of consecutive short intervals.
 *
 * Grouped into runs rather than reported per interval because the action is
 * taken over a stretch: "offer 15:00 to 17:00" is a thing a supervisor can
 * post, and four separate half-hour alerts is the same fact said four times.
 *
 * Intervals with no forecast volume are skipped rather than treated as covered.
 * An interval nobody expects calls in is not a gap, and at 03:00 the whole
 * night would otherwise report as short.
 */
export function findGaps(coverage: readonly CoverageInterval[], minShortfall = 1): Gap[] {
  const gaps: Gap[] = [];
  let current: Gap | null = null;

  for (const interval of coverage) {
    const short = interval.volume > 0 && -interval.variance >= minShortfall;
    if (!short) {
      current = null;
      continue;
    }
    const shortfall = -interval.variance;
    if (current) {
      current.to = interval.startTime;
      current.intervals += 1;
      current.shortBy = Math.max(current.shortBy, shortfall);
      current.agentIntervals += shortfall;
      current.worstServiceLevel = Math.min(current.worstServiceLevel, interval.serviceLevel);
    } else {
      current = {
        from: interval.startTime,
        to: interval.startTime,
        intervals: 1,
        shortBy: shortfall,
        agentIntervals: shortfall,
        worstServiceLevel: interval.serviceLevel,
      };
      gaps.push(current);
    }
  }

  // Worst first: the biggest hole is the one to fix while there is still time.
  return gaps.sort((a, b) => b.agentIntervals - a.agentIntervals);
}

/** Runs with people to spare, which is where a moved break comes from. */
export function findSurpluses(coverage: readonly CoverageInterval[], minSurplus = 1): Surplus[] {
  const surpluses: Surplus[] = [];
  let current: Surplus | null = null;

  for (const interval of coverage) {
    const spare = interval.volume > 0 && interval.variance >= minSurplus;
    if (!spare) {
      current = null;
      continue;
    }
    if (current) {
      current.to = interval.startTime;
      current.intervals += 1;
      current.agentIntervals += interval.variance;
    } else {
      current = {
        from: interval.startTime,
        to: interval.startTime,
        intervals: 1,
        agentIntervals: interval.variance,
      };
      surpluses.push(current);
    }
  }
  return surpluses;
}

export type ActionKind = 'MOVE_BREAKS' | 'OFFER_EXTRA_HOURS' | 'UNFILLABLE';

export interface Recommendation {
  kind: ActionKind;
  gap: Gap;
  /** Agent-intervals this action would cover. */
  covers: number;
  /** Whole people for the whole run, which is what an offer is posted in. */
  people: number;
  /** Where the cover comes from, when it is being moved rather than bought. */
  source?: Surplus;
  headline: string;
  detail: string;
}

/** Half-hour intervals, matching the forecast grid. */
const MINUTES = 30;

function hours(agentIntervals: number): number {
  return (agentIntervals * MINUTES) / 60;
}

/**
 * How far apart two interval labels are, in intervals.
 *
 * A surplus is only worth moving from if it is near the gap: a break shifted
 * by six hours is not a break move, it is a different shift.
 */
function distance(a: string, b: string): number {
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return Math.abs(mins(a) - mins(b)) / MINUTES;
}

export const MAX_MOVE_DISTANCE = 4; // two hours either side

/**
 * A run of intervals, written the way somebody would say it.
 *
 * A one-interval run rendered as "15:30–15:30", which reads as a mistake. The
 * end label is the *start* of the last interval, so a run ending at 16:00 in
 * fact covers until 16:30 — spelling that out is what makes the offer window
 * postable without somebody having to work it out.
 */
function span(from: string, to: string): string {
  const end = addInterval(to);
  return `${from}–${end}`;
}

function addInterval(time: string): string {
  const mins = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + MINUTES;
  const wrapped = mins % (24 * 60);
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/**
 * What to do about each gap.
 *
 * Surpluses are consumed as they are allocated, so the same spare person is
 * never offered to two different gaps — which is exactly the mistake that makes
 * an automated suggestion untrustworthy the first time somebody checks it.
 */
export function recommend(params: {
  coverage: readonly CoverageInterval[];
  /** How many people are actually available to offer extra hours to. */
  availableForExtraHours?: number;
  minShortfall?: number;
}): Recommendation[] {
  const gaps = findGaps(params.coverage, params.minShortfall);
  const surpluses = findSurpluses(params.coverage).map((s) => ({ ...s }));
  let remainingPeople = params.availableForExtraHours ?? 0;

  const out: Recommendation[] = [];

  for (const gap of gaps) {
    let uncovered = gap.agentIntervals;

    // 1. Free cover first.
    const near = surpluses
      .filter((s) => s.agentIntervals > 0)
      .map((s) => ({
        surplus: s,
        distance: Math.min(distance(s.to, gap.from), distance(gap.to, s.from)),
      }))
      .filter((s) => s.distance <= MAX_MOVE_DISTANCE)
      .sort((a, b) => a.distance - b.distance);

    for (const { surplus } of near) {
      if (uncovered <= 0) break;
      const moved = Math.min(surplus.agentIntervals, uncovered);
      if (moved <= 0) continue;
      surplus.agentIntervals -= moved;
      uncovered -= moved;
      out.push({
        kind: 'MOVE_BREAKS',
        gap,
        covers: moved,
        people: Math.ceil(moved / gap.intervals),
        source: { ...surplus, agentIntervals: moved },
        headline: `Move breaks out of ${span(gap.from, gap.to)}`,
        detail:
          `${span(surplus.from, surplus.to)} has ${hours(moved)} agent hours to spare. ` +
          `Shifting breaks and lunches there from ${span(gap.from, gap.to)} covers ${hours(moved)} of the ` +
          `${hours(gap.agentIntervals)} hours short, at no cost.`,
      });
    }

    if (uncovered <= 0) continue;

    // 2. Buy what is left.
    const peopleNeeded = Math.ceil(uncovered / gap.intervals);
    if (remainingPeople > 0) {
      const offering = Math.min(peopleNeeded, remainingPeople);
      remainingPeople -= offering;
      const covered = Math.min(uncovered, offering * gap.intervals);
      out.push({
        kind: 'OFFER_EXTRA_HOURS',
        gap,
        covers: covered,
        people: offering,
        headline: `Offer extra hours for ${span(gap.from, gap.to)}`,
        detail:
          `Still ${hours(uncovered)} agent hours short. ` +
          `${offering} ${offering === 1 ? 'person is' : 'people are'} off and under their weekly limit — ` +
          `offering ${span(gap.from, gap.to)} covers ${hours(covered)} of it.`,
      });
      uncovered -= covered;
    }

    if (uncovered > 0) {
      out.push({
        kind: 'UNFILLABLE',
        gap,
        covers: 0,
        people: 0,
        headline: `${span(gap.from, gap.to)} cannot be covered from this team`,
        detail:
          `${hours(uncovered)} agent hours short with nobody available who is under their weekly limit. ` +
          `Service level bottoms out at ${Math.round(gap.worstServiceLevel * 100)}%. ` +
          `This needs a decision rather than a roster change.`,
      });
    }
  }

  return out;
}
