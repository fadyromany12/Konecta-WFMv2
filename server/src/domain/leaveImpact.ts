/**
 * What approving a day off would do to coverage.
 *
 * The single most valuable cross-check the tool can make, and the one it was
 * missing: both halves of the answer were already here — a forecast that says
 * how many people each half hour needs, and a roster that says how many it has
 * — and nothing put them together at the moment somebody clicks Approve.
 *
 * A supervisor approving leave three weeks out cannot hold a coverage chart in
 * their head. They approve, and the shortfall is discovered on the morning it
 * bites. This turns that into a sentence at the point of decision.
 *
 * Deliberately advisory. It reports; it does not refuse. Leave is frequently
 * approved *because* somebody needs the day regardless of coverage, and a tool
 * that blocks it would simply be worked around outside the tool — which is
 * worse, because then the roster does not know either.
 */

import type { CoverageInterval } from './forecast.js';

export interface IntervalImpact {
  startTime: string;
  /** Cover before the leave is granted. */
  before: number;
  /** Cover once this person is removed. */
  after: number;
  requiredAgents: number;
  /** Negative means short after the change. */
  variance: number;
  /** True when this interval is only short *because* of the leave. */
  newlyShort: boolean;
}

export interface LeaveImpact {
  date: string;
  /** Intervals the advisor was rostered to cover on this day. */
  affectedIntervals: number;
  /** Intervals that go from covered to short if this is approved. */
  newlyShortIntervals: number;
  /** Intervals already short that get worse. */
  worsenedIntervals: number;
  /** The worst interval after the change, if any is short. */
  worst: IntervalImpact | null;
  /** Ready to show beside the Approve button. */
  summary: string;
  /** Whether a supervisor should look before approving. */
  severity: 'none' | 'watch' | 'high';
  intervals: IntervalImpact[];
}

/**
 * Recompute cover for one day with one person's contribution removed.
 *
 * `coveredIntervals` is which half hours that advisor was actually rostered to
 * answer contacts in — not simply "they were at work", because time already
 * scheduled as training or a meeting was never covering the queue and removing
 * it costs nothing.
 */
export function leaveImpact(params: {
  date: string;
  coverage: CoverageInterval[];
  coveredIntervals: Set<string>;
  advisorName?: string;
}): LeaveImpact {
  const { date, coverage, coveredIntervals } = params;

  const intervals: IntervalImpact[] = coverage
    .filter((c) => coveredIntervals.has(c.startTime))
    .map((c) => {
      const after = Math.max(0, c.scheduledAgents - 1);
      const variance = after - c.requiredAgents;
      return {
        startTime: c.startTime,
        before: c.scheduledAgents,
        after,
        requiredAgents: c.requiredAgents,
        variance,
        // Only counts where there is demand: losing a body in an interval with
        // no forecast volume is not a coverage problem.
        newlyShort: c.volume > 0 && c.variance >= 0 && variance < 0,
      };
    });

  const withDemand = intervals.filter((i) => i.requiredAgents > 0);
  const newlyShort = withDemand.filter((i) => i.newlyShort);
  const worsened = withDemand.filter((i) => !i.newlyShort && i.variance < 0);
  const short = withDemand.filter((i) => i.variance < 0);
  const worst = short.length === 0 ? null : short.reduce((a, b) => (b.variance < a.variance ? b : a));

  const who = params.advisorName ? `${params.advisorName} ` : '';
  let summary: string;

  if (short.length === 0) {
    summary = `${date} stays covered without ${who ? who.trim() : 'them'}.`;
  } else if (newlyShort.length === 0) {
    summary =
      `${date} is already short in ${short.length} interval${short.length === 1 ? '' : 's'}; ` +
      `approving this makes ${short.length === 1 ? 'it' : 'them'} worse, worst at ${worst!.startTime}.`;
  } else {
    summary =
      `Approving this leaves ${newlyShort.length} interval${newlyShort.length === 1 ? '' : 's'} short on ${date}` +
      `, from ${newlyShort[0].startTime}` +
      (worst ? `, worst ${Math.abs(worst.variance)} under at ${worst.startTime}` : '') +
      '.';
  }

  // Severity reads the outcome, not how the day got there.
  //
  // The first version only escalated when intervals went *newly* short, which
  // meant a peak already one person down and about to be three down stayed a
  // gentle "watch" — the case where a supervisor most needs to look. Whether an
  // interval was already failing does not make it less short afterwards.
  const severity: LeaveImpact['severity'] =
    short.length === 0
      ? 'none'
      : // Three short intervals is most of a peak rather than a blip, and two
        // under in any single interval is a service failure people will feel.
        short.length >= 3 || (worst && worst.variance <= -2)
        ? 'high'
        : 'watch';

  return {
    date,
    affectedIntervals: intervals.length,
    newlyShortIntervals: newlyShort.length,
    worsenedIntervals: worsened.length,
    worst,
    summary,
    severity,
    intervals,
  };
}

/** Roll several days into one line, for a request spanning a week. */
export function summariseLeaveImpact(days: LeaveImpact[]): {
  severity: LeaveImpact['severity'];
  summary: string;
  newlyShortIntervals: number;
} {
  const newlyShortIntervals = days.reduce((sum, d) => sum + d.newlyShortIntervals, 0);
  const worstDay = days.find((d) => d.severity === 'high') ?? days.find((d) => d.severity === 'watch');

  if (!worstDay) {
    return {
      severity: 'none',
      summary:
        days.length === 1
          ? days[0].summary
          : `All ${days.length} days stay covered.`,
      newlyShortIntervals: 0,
    };
  }

  if (days.length === 1) {
    return { severity: worstDay.severity, summary: worstDay.summary, newlyShortIntervals };
  }

  const affectedDays = days.filter((d) => d.severity !== 'none').length;
  return {
    severity: worstDay.severity,
    summary:
      `${affectedDays} of ${days.length} days lose cover — ${newlyShortIntervals} interval` +
      `${newlyShortIntervals === 1 ? '' : 's'} newly short. Worst: ${worstDay.summary}`,
    newlyShortIntervals,
  };
}
