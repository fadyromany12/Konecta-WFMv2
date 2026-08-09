/**
 * What a day costs.
 *
 * Everything else in Pulse counts hours. This module is the only place that
 * says what an hour is *worth*, and it says it in hours rather than money:
 * eight hours worked on a public holiday costs twenty-four paid hours. Nobody's
 * salary is in this system and it should stay that way — a paid-hours figure
 * multiplies into money the moment someone who has the rates wants it to, and
 * until then it cannot leak anything or be wrong about anybody in particular.
 *
 * The rates are Egyptian. Labour Law No. 14 of 2025 sets overtime at a third
 * again for daytime hours and seven tenths again at night, night being 22:00 to
 * 06:00. The rest are Konecta's, given to me directly:
 *
 * - **A cancelled rest day pays double.** Somebody who gave up their day off is
 *   not doing overtime, they are doing a different kind of day.
 * - **A public holiday worked pays triple, or double plus a day in the annual
 *   bank.** Cash now or leave later, worth roughly the same, and which one it
 *   is belongs to the supervisor at the moment of approval.
 * - **Overtime is uncapped**, and never excuses a short turnaround. That is a
 *   working-time rule and it lives in `workingTime.ts`, deliberately out of
 *   reach of anything in here.
 *
 * ## The one rule that is a judgement rather than a number
 *
 * Premiums do not stack. A day has a character — ordinary, cancelled rest day,
 * public holiday — and that character sets the rate for every hour worked in
 * it. Overtime on a holiday is paid at the holiday rate, not the holiday rate
 * plus a third. This is the common reading and it is the safer one to be wrong
 * about in the direction of, since triple already exceeds anything the stacking
 * interpretation would reach for a normal day's overtime. It is called out here
 * because it is the assumption most likely to differ between employers, and the
 * single place to change it is `characterRate` below.
 */

import {
  MEAL_CODE,
  OVERTIME_CODE,
  PAID_TIME_OFF_CODES,
  isRowPaid,
  rowMinutes,
  type TimecardRow,
} from './timecard.js';
import { toSegments, type ScheduleShift } from './schedule.js';
import {
  addDays,
  addMinutes,
  dateOf,
  formatDuration,
  stamp,
  toMinutes,
  type DateStr,
  type Stamp,
  type TimeStr,
} from './time.js';

/** What kind of day this was for the person who worked it. */
export type DayCharacter = 'ORDINARY' | 'REST_DAY' | 'PUBLIC_HOLIDAY';

/** The two ways a worked public holiday can be settled. */
export type HolidayElection = 'PAY_3X' | 'PAY_2X_PLUS_DAY';

export interface PayRates {
  /** Multiplier on daytime overtime. Egypt: base + 35%. */
  overtimeDay: number;
  /** Multiplier on overtime falling in the night window. Egypt: base + 70%. */
  overtimeNight: number;
  /** Start of the night window, inclusive. */
  nightFrom: TimeStr;
  /** End of the night window, exclusive. Earlier than `nightFrom` means it wraps midnight. */
  nightTo: TimeStr;
  /** Every hour worked on a rest day that was cancelled. */
  restDayWorked: number;
  /** Every hour worked on a public holiday, when settled in cash. */
  holidayWorked: number;
  /** Every hour worked on a public holiday, when a day is banked as well. */
  holidayWorkedWithDayInLieu: number;
  /** Hours credited to the annual bank for one banked day. */
  dayInLieuHours: number;
  /** Hours in a day before the rest is overtime, for costing a plan. */
  dailyNormHours: number;
  /** The shorter working day Egypt keeps through Ramadan. */
  ramadanNormHours: number;
  /**
   * A shift ending at or after this time earns the night allowance.
   *
   * Deliberately *not* the same as the night overtime window. That one asks
   * which hours were worked; this asks what kind of shift it was. Somebody
   * finishing at 21:30 has worked a night shift by any ordinary reckoning and
   * has not touched 22:00–06:00 at all.
   */
  nightAllowanceEndsAfter: TimeStr;
}

/**
 * The rates in force.
 *
 * Overtime and the night window are statutory. The rest are policy and are the
 * numbers Konecta gave; they are here rather than in the database on purpose,
 * so that changing what an hour is worth is a reviewed change with a date on it
 * rather than a form somebody filled in.
 */
export const EGYPT_RATES: PayRates = {
  overtimeDay: 1.35,
  overtimeNight: 1.7,
  nightFrom: '22:00',
  nightTo: '06:00',
  restDayWorked: 2,
  holidayWorked: 3,
  holidayWorkedWithDayInLieu: 2,
  dayInLieuHours: 8,
  dailyNormHours: 8,
  ramadanNormHours: 6,
  nightAllowanceEndsAfter: '21:00',
};

export type PayKind =
  | 'REGULAR'
  | 'OVERTIME_DAY'
  | 'OVERTIME_NIGHT'
  | 'REST_DAY'
  | 'PUBLIC_HOLIDAY'
  | 'PAID_TIME_OFF';

export interface PayLine {
  kind: PayKind;
  label: string;
  /** Clock minutes. */
  minutes: number;
  multiplier: number;
  /** `minutes × multiplier`: the cost, in minutes at the base rate. */
  paidMinutes: number;
}

export interface PayBreakdown {
  dayCharacter: DayCharacter;
  election: HolidayElection | null;
  /** A public holiday was worked and nobody has chosen how to settle it yet. */
  electionOutstanding: boolean;
  lines: PayLine[];
  /** Clock minutes actually worked, premium or not. */
  workedMinutes: number;
  /** What it costs, in minutes at the base rate. */
  paidMinutes: number;
  /** The part of the cost that is premium: `paidMinutes − workedMinutes − paid time off`. */
  premiumMinutes: number;
  /** Hours owed to the annual bank because of how a holiday was settled. */
  dayInLieuHours: number;
  notes: string[];
  formatted: {
    worked: string;
    paid: string;
    premium: string;
  };
}

const EMPTY_FORMATTED = { worked: '00:00', paid: '00:00', premium: '00:00' };

/** A stretch of clock time, used to split worked minutes at a threshold. */
interface Interval {
  startAt: Stamp;
  endAt: Stamp;
}

/**
 * The multiplier a day's character imposes on every hour worked in it, or
 * `null` on an ordinary day, where the split between regular and overtime
 * decides instead.
 *
 * This function *is* the no-stacking rule. An employer who pays holiday
 * overtime at holiday-rate-plus-overtime changes it here and nowhere else.
 */
function characterRate(
  character: DayCharacter,
  election: HolidayElection | null,
  rates: PayRates,
): number | null {
  if (character === 'REST_DAY') return rates.restDayWorked;
  if (character === 'PUBLIC_HOLIDAY') {
    return election === 'PAY_2X_PLUS_DAY' ? rates.holidayWorkedWithDayInLieu : rates.holidayWorked;
  }
  return null;
}

/**
 * Cost a timecard: what was actually worked.
 *
 * Overtime is the time coded `OT`, not the time past eight hours. Those are two
 * different claims and this module deliberately makes the weaker one — a
 * supervisor has looked at the card and coded it, and silently re-deciding
 * their coding at the pay stage would produce a number that disagrees with the
 * card it came from. Where the two readings differ, that is said in `notes`
 * rather than acted on.
 */
export function costTimecard(params: {
  rows: TimecardRow[];
  dayCharacter: DayCharacter;
  election?: HolidayElection | null;
  rates?: PayRates;
}): PayBreakdown {
  const rates = params.rates ?? EGYPT_RATES;
  const character = params.dayCharacter;
  const election = params.election ?? null;
  const notes: string[] = [];

  const paid = params.rows.filter((row) => rowMinutes(row) > 0 && isRowPaid(row));
  const overtime = paid.filter((row) => row.code === OVERTIME_CODE);
  const timeOff = paid.filter((row) => PAID_TIME_OFF_CODES.has(row.code));
  const regular = paid.filter(
    (row) => row.code !== OVERTIME_CODE && !PAID_TIME_OFF_CODES.has(row.code),
  );

  const workedMinutes = total(regular) + total(overtime);
  const timeOffMinutes = total(timeOff);

  const lines: PayLine[] = [];
  const flat = characterRate(character, election, rates);

  if (flat !== null) {
    // The whole day is one rate, so overtime carries no separate premium and
    // the regular/overtime split stops meaning anything for pay.
    if (workedMinutes > 0) {
      lines.push(
        line(
          character === 'REST_DAY' ? 'REST_DAY' : 'PUBLIC_HOLIDAY',
          character === 'REST_DAY' ? 'Rest day worked' : 'Public holiday worked',
          workedMinutes,
          flat,
        ),
      );
    }
    if (workedMinutes > 0 && total(overtime) > 0) {
      notes.push(
        `${formatDuration(total(overtime))} is coded as overtime, but every hour of a ` +
          `${character === 'REST_DAY' ? 'cancelled rest day' : 'public holiday'} already pays ` +
          `${flat}×, so no separate overtime premium applies.`,
      );
    }
  } else {
    if (total(regular) > 0) lines.push(line('REGULAR', 'Worked', total(regular), 1));
    const split = splitNight(intervals(overtime), rates);
    if (split.day > 0) lines.push(line('OVERTIME_DAY', 'Overtime, daytime', split.day, rates.overtimeDay));
    if (split.night > 0) {
      lines.push(
        line(
          'OVERTIME_NIGHT',
          `Overtime, ${rates.nightFrom}–${rates.nightTo}`,
          split.night,
          rates.overtimeNight,
        ),
      );
    }

    // Said, not acted on. See the note on this function.
    const norm = rates.dailyNormHours * 60;
    if (workedMinutes > norm && total(overtime) < workedMinutes - norm) {
      notes.push(
        `${formatDuration(workedMinutes)} worked but only ${formatDuration(total(overtime))} ` +
          `coded as overtime. Past ${rates.dailyNormHours} hours the balance would be ` +
          `${formatDuration(workedMinutes - norm)}. Costed as coded.`,
      );
    }
  }

  // Paid time off is paid time off whatever kind of day it lands on: the person
  // was not there, so no premium for being there can attach to it.
  if (timeOffMinutes > 0) lines.push(line('PAID_TIME_OFF', 'Paid time off', timeOffMinutes, 1));

  let dayInLieuHours = 0;
  let electionOutstanding = false;
  if (character === 'PUBLIC_HOLIDAY' && workedMinutes > 0) {
    if (election === 'PAY_2X_PLUS_DAY') {
      dayInLieuHours = rates.dayInLieuHours;
      notes.push(
        `Settled at ${rates.holidayWorkedWithDayInLieu}× plus ${rates.dayInLieuHours} hours ` +
          'added to the annual bank.',
      );
    } else if (election === null) {
      electionOutstanding = true;
      notes.push(
        `A public holiday was worked and has not been settled. Costed at ` +
          `${rates.holidayWorked}× until a supervisor chooses between that and ` +
          `${rates.holidayWorkedWithDayInLieu}× plus a day in the annual bank.`,
      );
    }
  }

  return assemble({ character, election, electionOutstanding, lines, workedMinutes, timeOffMinutes, dayInLieuHours, notes });
}

/**
 * Cost a shift that has not happened yet: what a roster commits to.
 *
 * A plan carries no codes, so here overtime *is* the time past the daily norm —
 * the opposite of `costTimecard`, and for the same reason. There is no
 * supervisor's judgement to defer to, so the rule has to make the call, and it
 * makes it chronologically: the hours past the norm are the last ones worked,
 * which is what decides whether they fall in the night window.
 */
export function costShift(params: {
  shift: ScheduleShift;
  dayCharacter: DayCharacter;
  election?: HolidayElection | null;
  rates?: PayRates;
}): PayBreakdown {
  const rates = params.rates ?? EGYPT_RATES;
  const character = params.dayCharacter;
  const election = params.election ?? null;

  // A shift block is one of three things, and they cost differently:
  // time on the clock, paid leave, and time that is neither. An unpaid meal in
  // the middle of a shift must not push the hours after it into overtime, and
  // a planned day of holiday is paid without anybody having worked it.
  const segments = toSegments(params.shift).filter((segment) => segment.minutes > 0);
  const worked = segments
    .filter((segment) => !OFF_CLOCK_ACTIVITIES.has(segment.activityKey))
    .filter((segment) => !PAID_LEAVE_ACTIVITIES.has(segment.activityKey))
    .map((segment) => ({ startAt: segment.startAt, endAt: segment.endAt }));
  const timeOffMinutes = segments
    .filter((segment) => PAID_LEAVE_ACTIVITIES.has(segment.activityKey))
    .reduce((sum, segment) => sum + segment.minutes, 0);

  const workedMinutes = worked.reduce((sum, i) => sum + span(i), 0);
  const lines: PayLine[] = [];
  const notes: string[] = [];
  const flat = characterRate(character, election, rates);

  if (flat !== null) {
    if (workedMinutes > 0) {
      lines.push(
        line(
          character === 'REST_DAY' ? 'REST_DAY' : 'PUBLIC_HOLIDAY',
          character === 'REST_DAY' ? 'Rest day worked' : 'Public holiday worked',
          workedMinutes,
          flat,
        ),
      );
    }
  } else {
    const { before, after } = splitAt(worked, rates.dailyNormHours * 60);
    const regular = before.reduce((sum, i) => sum + span(i), 0);
    if (regular > 0) lines.push(line('REGULAR', 'Planned', regular, 1));
    const overtime = splitNight(after, rates);
    if (overtime.day > 0) {
      lines.push(line('OVERTIME_DAY', 'Overtime, daytime', overtime.day, rates.overtimeDay));
    }
    if (overtime.night > 0) {
      lines.push(
        line(
          'OVERTIME_NIGHT',
          `Overtime, ${rates.nightFrom}–${rates.nightTo}`,
          overtime.night,
          rates.overtimeNight,
        ),
      );
    }
  }

  if (timeOffMinutes > 0) lines.push(line('PAID_TIME_OFF', 'Paid time off', timeOffMinutes, 1));

  const electionOutstanding = character === 'PUBLIC_HOLIDAY' && workedMinutes > 0 && election === null;
  if (electionOutstanding) {
    notes.push(
      `Planned on a public holiday. Costed at ${rates.holidayWorked}× until it is settled.`,
    );
  }

  return assemble({
    character,
    election,
    electionOutstanding,
    lines,
    workedMinutes,
    timeOffMinutes,
    dayInLieuHours: election === 'PAY_2X_PLUS_DAY' && workedMinutes > 0 ? rates.dayInLieuHours : 0,
    notes,
  });
}

/** Add breakdowns together, for a week, a team or a whole roster. */
export function totalCost(breakdowns: PayBreakdown[]): {
  workedMinutes: number;
  paidMinutes: number;
  premiumMinutes: number;
  dayInLieuHours: number;
  electionsOutstanding: number;
  byKind: Record<PayKind, number>;
  formatted: { worked: string; paid: string; premium: string };
} {
  const byKind = {
    REGULAR: 0,
    OVERTIME_DAY: 0,
    OVERTIME_NIGHT: 0,
    REST_DAY: 0,
    PUBLIC_HOLIDAY: 0,
    PAID_TIME_OFF: 0,
  } as Record<PayKind, number>;

  let workedMinutes = 0;
  let paidMinutes = 0;
  let premiumMinutes = 0;
  let dayInLieuHours = 0;
  let electionsOutstanding = 0;

  for (const b of breakdowns) {
    workedMinutes += b.workedMinutes;
    paidMinutes += b.paidMinutes;
    premiumMinutes += b.premiumMinutes;
    dayInLieuHours += b.dayInLieuHours;
    if (b.electionOutstanding) electionsOutstanding++;
    for (const l of b.lines) byKind[l.kind] += l.minutes;
  }

  return {
    workedMinutes,
    paidMinutes,
    premiumMinutes,
    dayInLieuHours,
    electionsOutstanding,
    byKind,
    formatted: {
      worked: formatDuration(workedMinutes),
      paid: formatDuration(paidMinutes),
      premium: formatDuration(premiumMinutes),
    },
  };
}

/** An empty day, so callers can total a roster without special-casing rest days. */
export function noCost(character: DayCharacter = 'ORDINARY'): PayBreakdown {
  return {
    dayCharacter: character,
    election: null,
    electionOutstanding: false,
    lines: [],
    workedMinutes: 0,
    paidMinutes: 0,
    premiumMinutes: 0,
    dayInLieuHours: 0,
    notes: [],
    formatted: EMPTY_FORMATTED,
  };
}

// ------------------------------------------------------------------ internals

/** Schedule activities that cost nothing: nobody is on the clock and nobody is paid. */
const OFF_CLOCK_ACTIVITIES = new Set(['LUNCH', 'UTO']);
/** Schedule activities that are paid at the base rate without being worked. */
const PAID_LEAVE_ACTIVITIES = new Set(['PTO']);

function assemble(parts: {
  character: DayCharacter;
  election: HolidayElection | null;
  electionOutstanding: boolean;
  lines: PayLine[];
  workedMinutes: number;
  timeOffMinutes: number;
  dayInLieuHours: number;
  notes: string[];
}): PayBreakdown {
  const paidMinutes = parts.lines.reduce((sum, l) => sum + l.paidMinutes, 0);
  // Premium is what the multipliers added, so paid time off — which is paid at
  // the base rate for hours nobody worked — belongs in neither term.
  const premiumMinutes = round(paidMinutes - parts.workedMinutes - parts.timeOffMinutes);
  return {
    dayCharacter: parts.character,
    election: parts.election,
    electionOutstanding: parts.electionOutstanding,
    lines: parts.lines,
    workedMinutes: parts.workedMinutes,
    paidMinutes,
    premiumMinutes,
    dayInLieuHours: parts.dayInLieuHours,
    notes: parts.notes,
    formatted: {
      worked: formatDuration(parts.workedMinutes),
      paid: formatDuration(paidMinutes),
      premium: formatDuration(premiumMinutes),
    },
  };
}

function line(kind: PayKind, label: string, minutes: number, multiplier: number): PayLine {
  return { kind, label, minutes, multiplier, paidMinutes: round(minutes * multiplier) };
}

/** Multipliers like 1.35 make binary fractions; a paid-minute count should not carry them. */
function round(minutes: number): number {
  return Math.round(minutes * 100) / 100;
}

function total(rows: TimecardRow[]): number {
  return rows.reduce((sum, row) => sum + Math.max(0, rowMinutes(row)), 0);
}

function intervals(rows: TimecardRow[]): Interval[] {
  return rows
    .map((row) => ({ startAt: row.startAt, endAt: row.endAt }))
    .sort((a, b) => toMinutes(a.startAt) - toMinutes(b.startAt));
}

function span(interval: Interval): number {
  return Math.max(0, toMinutes(interval.endAt) - toMinutes(interval.startAt));
}

/**
 * Cut a run of intervals at a cumulative-minutes threshold, splitting whichever
 * interval straddles it. Used to find which *clock* hours are the overtime ones
 * when overtime is defined by how many hours came before them.
 */
function splitAt(list: Interval[], threshold: number): { before: Interval[]; after: Interval[] } {
  const before: Interval[] = [];
  const after: Interval[] = [];
  let used = 0;
  for (const interval of list) {
    const minutes = span(interval);
    if (used >= threshold) {
      after.push(interval);
    } else if (used + minutes <= threshold) {
      before.push(interval);
    } else {
      const cut = addMinutes(interval.startAt, threshold - used);
      before.push({ startAt: interval.startAt, endAt: cut });
      after.push({ startAt: cut, endAt: interval.endAt });
    }
    used += minutes;
  }
  return { before, after };
}

/** Split a run of intervals into minutes inside and outside the night window. */
function splitNight(list: Interval[], rates: PayRates): { day: number; night: number } {
  let night = 0;
  let all = 0;
  for (const interval of list) {
    all += span(interval);
    night += nightMinutes(interval, rates.nightFrom, rates.nightTo);
  }
  return { day: round(all - night), night: round(night) };
}

/**
 * Minutes of an interval that fall in a daily window, which may wrap midnight.
 *
 * Walks the days the interval touches — starting one day early, so a window
 * opened the previous evening is seen — and sums the overlaps. Two or three
 * iterations for any real shift; the cap is there for a corrupt row rather than
 * a legitimate one.
 */
export function nightMinutes(interval: Interval, from: TimeStr, to: TimeStr): number {
  // A zero-width window is no window. Reading `from === to` as twenty-four
  // hours would make every minute a night minute on a typo.
  if (from === to) return 0;

  const start = toMinutes(interval.startAt);
  const end = toMinutes(interval.endAt);
  if (end <= start) return 0;

  const wraps = to < from;
  const last = dateOf(interval.endAt);
  let total = 0;
  let date = addDays(dateOf(interval.startAt), -1);

  for (let guard = 0; guard < 400 && date <= last; guard++) {
    const windowStart = toMinutes(stamp(date, from));
    const windowEnd = toMinutes(stamp(wraps ? addDays(date, 1) : date, to));
    total += Math.max(0, Math.min(end, windowEnd) - Math.max(start, windowStart));
    date = addDays(date, 1);
  }
  return total;
}

/**
 * Does this shift earn the night allowance?
 *
 * The test is when it *finishes*, not which hours it covers. Konecta pays a
 * monthly allowance to people who work nights, and "worked a night" is a fact
 * about the shift as a whole — somebody clocking off at 21:30 has worked one,
 * and has not touched the statutory 22:00–06:00 window at all. The two rules
 * answer different questions and both apply.
 */
export function earnsNightAllowance(shift: ScheduleShift, rates: PayRates = EGYPT_RATES): boolean {
  const segments = toSegments(shift);
  if (segments.length === 0) return false;
  const endAt = segments[segments.length - 1].endAt;
  const finish = toMinutes(endAt) - toMinutes(stamp(dateOf(endAt), '00:00'));
  const threshold = hhmmToMinutes(rates.nightAllowanceEndsAfter);
  // A shift running past midnight finishes on the following date, so its
  // clock-time is small — but it is unambiguously a night. Anything that ends
  // on a later day than it started qualifies whatever the clock says.
  if (dateOf(endAt) !== dateOf(segments[0].startAt)) return true;
  return finish >= threshold;
}

export interface NightAllowance {
  /** Nights the roster asked for. */
  scheduled: number;
  /** Of those, the ones actually worked. */
  worked: number;
  /** `worked / scheduled`, or 0 when none were scheduled. */
  proportion: number;
  /** The same, as a percentage rounded to one place, for display. */
  percent: number;
  /** `20/22`, the form the allowance is actually discussed in. */
  fraction: string;
}

/**
 * How much of the monthly night allowance was earned.
 *
 * Deliberately a proportion rather than an amount. The allowance is a flat sum
 * per month pro-rated by attendance — twenty nights worked of twenty-two
 * rostered earns twenty twenty-seconds of it — and the sum belongs wherever
 * payroll keeps salaries, not here. Pulse knows which nights were rostered and
 * which were worked, which is the part payroll cannot work out for itself, and
 * multiplying by a figure it should not be holding would add nothing.
 *
 * A night that was rostered and then lost to leave or absence counts as
 * scheduled and not worked, which is what makes the fraction less than one.
 */
export function nightAllowance(days: { scheduled: boolean; worked: boolean }[]): NightAllowance {
  const scheduled = days.filter((d) => d.scheduled).length;
  const worked = days.filter((d) => d.scheduled && d.worked).length;
  const proportion = scheduled === 0 ? 0 : worked / scheduled;
  return {
    scheduled,
    worked,
    proportion,
    percent: Math.round(proportion * 1000) / 10,
    fraction: `${worked}/${scheduled}`,
  };
}

/**
 * The daily norm in force on a date: shorter through Ramadan.
 *
 * Egypt keeps a six hour working day for the month, so overtime starts two
 * hours earlier. Passed the Ramadan dates rather than working them out, because
 * deciding what Ramadan is belongs to the calendar and those dates are settled
 * by sighting rather than arithmetic.
 */
export function normHoursOn(date: DateStr, ramadan: ReadonlySet<DateStr>, rates: PayRates = EGYPT_RATES): number {
  return ramadan.has(date) ? rates.ramadanNormHours : rates.dailyNormHours;
}

function hhmmToMinutes(time: TimeStr): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/**
 * What kind of day this was.
 *
 * A rest day is one nobody was rostered on — so working it means the day off
 * was cancelled, which is exactly the case that pays double. A public holiday
 * beats a rest day: a holiday that happens to land on somebody's day off and is
 * then worked is still a holiday.
 */
export function dayCharacter(params: {
  date: DateStr;
  holidays: ReadonlySet<DateStr>;
  scheduled: boolean;
}): DayCharacter {
  if (params.holidays.has(params.date)) return 'PUBLIC_HOLIDAY';
  return params.scheduled ? 'ORDINARY' : 'REST_DAY';
}
