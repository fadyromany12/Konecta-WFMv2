/**
 * The rules about what you can ask a person to work.
 *
 * Everything the scheduler validated until now was about one day in isolation:
 * rows in order, no gaps, a meal where the rule requires one. All of it true,
 * and none of it capable of noticing that the day before ended at 07:30 and
 * this one starts at 09:00 — a shift pattern that is legal nowhere and that
 * the tool would happily save.
 *
 * Three rules, all of them the kind that carry a fine rather than a telling
 * off:
 *
 * - **Rest between shifts.** The Working Time Directive's eleven consecutive
 *   hours, which is the widest-used figure and the one most local rules track.
 * - **Consecutive working days.** Six, so a seventh day off falls somewhere in
 *   every seven.
 * - **Hours in a week.** Forty-eight, the same source.
 *
 * These are advisory, not refusals, and that is deliberate. Every one of them
 * is legitimately broken sometimes — somebody volunteers to cover, a person
 * asks to compress their week, an emergency happens — and a tool that refuses
 * gets worked around on paper, where nothing can see the breach at all. What
 * matters is that the breach is *visible at the moment it is created* and
 * attributable afterwards, which a warning achieves and a silent save does not.
 *
 * Approved leave is the exception and is refused elsewhere: rostering somebody
 * onto a day they are contractually not there is not a judgement call, it is a
 * contradiction in the data.
 */

import { diffDays, diffMinutes, type DateStr, type Stamp } from './time.js';
import { shiftSpan, toSegments, type ScheduleShift } from './schedule.js';
import type { Issue } from './timecard.js';

/**
 * Consecutive hours off between the end of one shift and the start of the next.
 *
 * Not an Egyptian requirement — Egypt specifies a weekly rest rather than a
 * turnaround — but kept deliberately as house policy, and explicitly unaffected
 * by overtime: extra hours never excuse a short turnaround.
 */
export const MIN_REST_HOURS = 11;
/** Days in a row before a rest day is owed. Egypt: a weekly rest of 24 hours. */
export const MAX_CONSECUTIVE_DAYS = 6;
/** Paid hours in a rolling seven days. Egypt: 48. */
export const MAX_WEEKLY_HOURS = 48;
/** Hours in one day before it is overtime. Egypt: 8. */
export const MAX_DAILY_HOURS = 8;
/**
 * Consecutive worked hours before a break is owed. Egypt: 5.
 *
 * The most commonly breached rule in a contact centre, because a busy afternoon
 * is exactly when a break gets pushed.
 */
export const MAX_HOURS_WITHOUT_BREAK = 5;
/**
 * Overtime in a day before it is worth remarking on.
 *
 * Overtime is uncapped by policy, so this never refuses. It is the statutory
 * figure, kept so that passing it leaves a trace on the record.
 */
export const OVERTIME_NOTE_HOURS = 2;

export interface WorkingTimeLimits {
  minRestHours: number;
  maxConsecutiveDays: number;
  maxWeeklyHours: number;
  maxDailyHours: number;
  maxHoursWithoutBreak: number;
  overtimeNoteHours: number;
}

export const DEFAULT_LIMITS: WorkingTimeLimits = {
  minRestHours: MIN_REST_HOURS,
  maxConsecutiveDays: MAX_CONSECUTIVE_DAYS,
  maxWeeklyHours: MAX_WEEKLY_HOURS,
  maxDailyHours: MAX_DAILY_HOURS,
  maxHoursWithoutBreak: MAX_HOURS_WITHOUT_BREAK,
  overtimeNoteHours: OVERTIME_NOTE_HOURS,
};

/** One day of somebody's roster, as the checks need to see it. */
export interface RosterDay {
  date: DateStr;
  shifts: ScheduleShift[];
}

export interface WorkingTimeBreach {
  kind: 'rest' | 'consecutive' | 'weekly' | 'daily' | 'break' | 'overtime';
  /** The day the breach is attributed to. */
  date: DateStr;
  message: string;
  /** How far past the limit, in the natural unit of that rule. */
  over: number;
}

/**
 * Judge a stretch of roster.
 *
 * `days` must be contiguous and must extend either side of whatever is being
 * changed — a shift moved onto Thursday can breach rest against Wednesday
 * *and* against Friday, and a window that starts on Thursday sees neither. The
 * caller is responsible for that padding because only it knows what changed;
 * see `rosterWindow` in the scheduling service.
 */
export function checkWorkingTime(params: {
  days: RosterDay[];
  limits?: WorkingTimeLimits;
  /** Only report breaches attributed to these days. */
  focus?: DateStr[];
}): WorkingTimeBreach[] {
  const limits = params.limits ?? DEFAULT_LIMITS;
  const focus = params.focus ? new Set(params.focus) : null;
  const breaches: WorkingTimeBreach[] = [];

  const sorted = [...params.days].sort((a, b) => (a.date < b.date ? -1 : 1));

  // --- Rest between consecutive shifts, across the whole window.
  //
  // Spans rather than days: an overnight shift belongs to the payroll date it
  // started on but ends the following morning, and comparing dates instead of
  // instants gets that exactly backwards.
  const spans = sorted
    .flatMap((day) =>
      day.shifts.map((shift) => {
        const span = shiftSpan(shift);
        return { date: day.date, startAt: span.startAt, endAt: span.endAt };
      }),
    )
    .sort((a, b) => (a.startAt < b.startAt ? -1 : 1));

  for (let i = 1; i < spans.length; i++) {
    const previous = spans[i - 1];
    const current = spans[i];
    const restMinutes = diffMinutes(previous.endAt, current.startAt);
    // Negative means the shifts overlap, which the per-day validator already
    // reports for one day and which this catches across a midnight boundary.
    if (restMinutes >= limits.minRestHours * 60) continue;
    breaches.push({
      kind: 'rest',
      date: current.date,
      over: Math.round(((limits.minRestHours * 60 - restMinutes) / 60) * 10) / 10,
      message:
        restMinutes < 0
          ? `The ${current.date} shift starts before the previous one has finished.`
          : `Only ${formatHours(restMinutes)} off before the ${current.date} shift — ` +
            `${limits.minRestHours} hours is the minimum.`,
    });
  }

  // --- Consecutive working days.
  //
  // Reported once per run, on the day the limit is passed, rather than on
  // every day after it. Nine warnings for one nine-day run is noise, and noise
  // is how a warning gets ignored.
  let runStart: DateStr | null = null;
  let runLength = 0;
  let previousDate: DateStr | null = null;
  let reported = false;

  for (const day of sorted) {
    const worked = day.shifts.length > 0;
    const contiguous = previousDate !== null && diffDays(previousDate, day.date) === 1;

    if (worked && contiguous && runStart !== null) {
      runLength++;
    } else if (worked) {
      runStart = day.date;
      runLength = 1;
      reported = false;
    } else {
      runStart = null;
      runLength = 0;
      reported = false;
    }

    if (worked && runLength > limits.maxConsecutiveDays && !reported) {
      breaches.push({
        kind: 'consecutive',
        date: day.date,
        over: runLength - limits.maxConsecutiveDays,
        message:
          `${day.date} is day ${runLength} in a row without a rest day, from ${runStart}. ` +
          `${limits.maxConsecutiveDays} is the maximum.`,
      });
      reported = true;
    }
    previousDate = day.date;
  }

  // --- Hours in any rolling seven days ending on a worked day.
  const minutesByDate = new Map<DateStr, number>();
  for (const day of sorted) {
    minutesByDate.set(
      day.date,
      day.shifts.reduce((sum, shift) => sum + shiftSpan(shift).minutes, 0),
    );
  }

  for (const day of sorted) {
    if ((minutesByDate.get(day.date) ?? 0) === 0) continue;
    let total = 0;
    for (const [date, minutes] of minutesByDate) {
      const back = diffDays(date, day.date);
      if (back >= 0 && back < 7) total += minutes;
    }
    if (total > limits.maxWeeklyHours * 60) {
      breaches.push({
        kind: 'weekly',
        date: day.date,
        over: Math.round((total / 60 - limits.maxWeeklyHours) * 10) / 10,
        message:
          `${formatHours(total)} scheduled in the seven days ending ${day.date} — ` +
          `${limits.maxWeeklyHours} hours is the maximum.`,
      });
    }
  }

  // --- Hours in a day, and the run before a break is owed.
  //
  // Both read the shift's own segments rather than its span, because a shift
  // that runs 09:00 to 19:00 with a two hour meal in the middle is eight hours
  // of work, not ten — and its longest unbroken run is what the break rule
  // cares about, not its total.
  for (const day of sorted) {
    if (focus && !focus.has(day.date)) continue;
    for (const shift of day.shifts) {
      const worked = workingRuns(shift);
      const total = worked.reduce((sum, run) => sum + run, 0);

      if (total > limits.maxDailyHours * 60) {
        const over = Math.round((total / 60 - limits.maxDailyHours) * 10) / 10;
        breaches.push({
          kind: over > limits.overtimeNoteHours ? 'overtime' : 'daily',
          date: day.date,
          over,
          message:
            over > limits.overtimeNoteHours
              ? `${formatHours(total)} worked on ${day.date} — ${over} hours past the ` +
                `${limits.maxDailyHours} hour day, and beyond the ${limits.overtimeNoteHours} hours ` +
                'overtime the law contemplates. Allowed by policy; recorded here because it is unusual.'
              : `${formatHours(total)} worked on ${day.date}, past the ${limits.maxDailyHours} hour day.`,
        });
      }

      const longest = Math.max(0, ...worked);
      if (longest > limits.maxHoursWithoutBreak * 60) {
        breaches.push({
          kind: 'break',
          date: day.date,
          over: Math.round((longest / 60 - limits.maxHoursWithoutBreak) * 10) / 10,
          message:
            `${formatHours(longest)} straight without a break on ${day.date} — ` +
            `${limits.maxHoursWithoutBreak} hours is the maximum before one is owed.`,
        });
      }
    }
  }

  const relevant = focus ? breaches.filter((b) => focus.has(b.date)) : breaches;

  // One weekly breach is enough — every day of an over-long week reports the
  // same fact — and it has to be the *worst* one. Keeping the first tipped a
  // sixty hour week as "2 hours over", because the earliest rolling window to
  // cross 48 barely crosses it. The number a supervisor needs is the peak.
  return worstWeeklyOnly(relevant);
}

/** The breaches as the schedule validator's own issue shape, so they travel together. */
export function workingTimeIssues(breaches: WorkingTimeBreach[]): Issue[] {
  return breaches.map((breach) => ({ level: 'warning' as const, message: breach.message }));
}

function worstWeeklyOnly(breaches: WorkingTimeBreach[]): WorkingTimeBreach[] {
  const weekly = breaches.filter((b) => b.kind === 'weekly');
  if (weekly.length <= 1) return breaches;
  const worst = weekly.reduce((a, b) => (b.over > a.over ? b : a));
  return breaches.filter((b) => b.kind !== 'weekly' || b === worst);
}

/**
 * The unbroken runs of *work* inside a shift, in minutes.
 *
 * A break or a meal ends a run; everything else — phone time, training, a
 * meeting — continues it, because the rule is about time on task rather than
 * time on the queue. Returns one entry per run, so the caller can ask both for
 * the total and for the longest.
 */
function workingRuns(shift: ScheduleShift): number[] {
  const runs: number[] = [];
  let current = 0;
  for (const segment of toSegments(shift)) {
    if (BREAK_ACTIVITIES.has(segment.activityKey)) {
      if (current > 0) runs.push(current);
      current = 0;
      continue;
    }
    current += segment.minutes;
  }
  if (current > 0) runs.push(current);
  return runs;
}

/** What counts as a break for the purposes of the five hour rule. */
const BREAK_ACTIVITIES = new Set(['BREAK', 'LUNCH']);

function formatHours(minutes: number): string {
  const hours = minutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} hour${rounded === 1 ? '' : 's'}`;
}

/** Whether a stamp falls inside an inclusive date range, for leave checks. */
export function withinRange(date: DateStr, start: DateStr, end: DateStr): boolean {
  return date >= start && date <= end;
}

export type { Stamp };
