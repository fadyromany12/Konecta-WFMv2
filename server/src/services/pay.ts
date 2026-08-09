/**
 * What a roster and a set of timecards cost.
 *
 * The arithmetic all lives in `domain/pay.ts`. This is the part that knows
 * where the facts are — whether somebody was rostered, whether the date is a
 * holiday, which way a supervisor settled it — and the part that has to write
 * a banked day into an accrual balance without losing it.
 */

import { audit, db, transact } from '../db/index.js';
import {
  EGYPT_RATES,
  costShift,
  costTimecard,
  dayCharacter,
  earnsNightAllowance,
  nightAllowance,
  noCost,
  totalCost,
  type DayCharacter,
  type HolidayElection,
  type NightAllowance,
  type PayBreakdown,
} from '../domain/pay.js';
import { ramadanDates } from '../domain/holidays.js';
import { dateRange, nowStamp, todayStr, type DateStr } from '../domain/time.js';
import { holidayDates } from './holidays.js';
import { getShifts } from './scheduling.js';
import { viewTimecard } from './timecards.js';

export { EGYPT_RATES } from '../domain/pay.js';

export interface DayCost extends PayBreakdown {
  userId: number;
  date: DateStr;
  name: string;
}

/**
 * What a stretch of somebody's actual worked time cost.
 *
 * Reads the timecard, so it is the record of what happened rather than what was
 * planned. A day with no card and no roster is a rest day that was taken, and
 * costs nothing — but it still appears, because a week's cost that silently
 * omits days is a week whose total nobody can check.
 */
export async function actualCost(params: {
  userId: number;
  start: DateStr;
  end: DateStr;
  actorId: number | null;
}): Promise<DayCost[]> {
  const holidays = await holidayDates(params.start, params.end);
  const out: DayCost[] = [];

  for (const date of dateRange(params.start, params.end)) {
    const shifts = await getShifts(params.userId, date, { includeDrafts: true });
    const character = dayCharacter({ date, holidays, scheduled: shifts.length > 0 });
    const view = await viewTimecard({
      userId: params.userId,
      date,
      autoGenerate: false,
      actorId: params.actorId,
    });

    const breakdown = view
      ? costTimecard({
          rows: view.rows,
          dayCharacter: character,
          election: (view.holidayElection ?? null) as HolidayElection | null,
        })
      : noCost(character);

    out.push({
      ...breakdown,
      userId: params.userId,
      date,
      name: view?.userName ?? '',
    });
  }
  return out;
}

/**
 * What a roster commits to before anybody works it.
 *
 * The number a planner needs while there is still time to change the plan —
 * and the reason the engine costs a shift as well as a card.
 */
export async function plannedCost(params: {
  userIds: number[];
  start: DateStr;
  end: DateStr;
  includeDrafts?: boolean;
}): Promise<DayCost[]> {
  const holidays = await holidayDates(params.start, params.end);
  const out: DayCost[] = [];

  for (const userId of params.userIds) {
    for (const date of dateRange(params.start, params.end)) {
      const shifts = await getShifts(userId, date, { includeDrafts: params.includeDrafts });
      const character = dayCharacter({ date, holidays, scheduled: shifts.length > 0 });
      if (shifts.length === 0) {
        out.push({ ...noCost(character), userId, date, name: '' });
        continue;
      }
      for (const shift of shifts) {
        out.push({
          ...costShift({ shift, dayCharacter: character }),
          userId,
          date,
          name: '',
        });
      }
    }
  }
  return out;
}

export function summariseCost(days: DayCost[]) {
  return totalCost(days);
}

/**
 * Settle a worked public holiday: triple time, or double plus a day in the bank.
 *
 * The banked day is credited here rather than at payroll, because payroll may
 * be weeks away and the advisor needs to see the day they were promised. It is
 * written in the same transaction as the election so the two can never
 * disagree, and a second call that repeats an existing election credits
 * nothing — otherwise a supervisor clicking twice banks two days.
 */
export async function electHolidaySettlement(params: {
  timecardId: number;
  election: HolidayElection;
  actorId: number;
}): Promise<{ ok: boolean; message: string }> {
  const card = await db.get<{
    id: number;
    user_id: number;
    payroll_date: string;
    holiday_election: string | null;
    protect_date: string | null;
  }>(
    `SELECT id, user_id, payroll_date, holiday_election, protect_date
     FROM timecards WHERE id = ?`,
    [params.timecardId],
  );
  if (!card) return { ok: false, message: 'No such timecard.' };

  const holidays = await holidayDates(card.payroll_date, card.payroll_date);
  if (!holidays.has(card.payroll_date)) {
    return { ok: false, message: `${card.payroll_date} is not a public holiday.` };
  }
  if (card.holiday_election === params.election) {
    return { ok: true, message: 'Already settled that way.' };
  }

  const banked = params.election === 'PAY_2X_PLUS_DAY' ? EGYPT_RATES.dayInLieuHours : 0;
  const unbanked = card.holiday_election === 'PAY_2X_PLUS_DAY' ? EGYPT_RATES.dayInLieuHours : 0;
  const delta = banked - unbanked;

  await transact(async () => {
    await db.run('UPDATE timecards SET holiday_election = ?, updated_at = ? WHERE id = ?', [
      params.election,
      nowStamp(),
      params.timecardId,
    ]);
    if (delta !== 0) await creditAccrual(card.user_id, 'VACATION', delta);
    await audit(params.actorId, 'timecard', params.timecardId, 'HOLIDAY_ELECTION', {
      election: params.election,
      was: card.holiday_election,
      bankedHours: delta,
      afterPayroll: !!card.protect_date,
    });
  });

  return {
    ok: true,
    message:
      params.election === 'PAY_3X'
        ? `Settled at ${EGYPT_RATES.holidayWorked}× pay.`
        : `Settled at ${EGYPT_RATES.holidayWorkedWithDayInLieu}× pay plus ${EGYPT_RATES.dayInLieuHours} hours added to the annual bank.`,
  };
}

/** Add to a balance, creating the row if this is the first credit of its kind. */
async function creditAccrual(userId: number, type: string, hours: number): Promise<void> {
  const info = await db.run(
    'UPDATE accruals SET balance_hours = balance_hours + ?, as_of = ? WHERE user_id = ? AND accrual_type = ?',
    [hours, todayStr(), userId, type],
  );
  if (info.changes === 0) {
    await db.run(
      'INSERT INTO accruals (user_id, accrual_type, balance_hours, as_of) VALUES (?, ?, ?, ?)',
      [userId, type, hours, todayStr()],
    );
  }
}

export type { DayCharacter, HolidayElection, PayBreakdown };

export interface NightAllowanceView extends NightAllowance {
  userId: number;
  month: string;
  /**
   * False while the month is still running, so a fraction read mid-month is
   * not mistaken for the one that gets paid.
   */
  complete: boolean;
  /** The nights themselves, so a disputed fraction can be checked day by day. */
  nights: { date: DateStr; worked: boolean }[];
}

/**
 * How much of the monthly night allowance somebody earned.
 *
 * A month rather than an arbitrary range, because the allowance is monthly and
 * a fraction of some other window would not mean anything.
 *
 * The days are returned alongside the fraction on purpose. "20/22" is the
 * number that gets paid and the number that gets argued about, and an advisor
 * asking which two nights they lost deserves an answer better than a
 * recalculation.
 */
export async function nightAllowanceFor(params: {
  userId: number;
  month: string;
  actorId: number | null;
}): Promise<NightAllowanceView> {
  const start = `${params.month}-01`;
  const monthEnd = lastDayOf(params.month);
  // Stop at today in the current month. A night still in the future has not
  // been missed — it has not happened — and counting it as unworked reported
  // somebody four elevenths of the way through the month as having lost seven
  // nights. Once the month is over this is simply the whole month.
  const today = todayStr();
  const end = monthEnd < today ? monthEnd : today;
  const complete = monthEnd <= today;

  const days: { scheduled: boolean; worked: boolean }[] = [];
  const nights: { date: DateStr; worked: boolean }[] = [];

  if (end < start) {
    return { ...nightAllowance([]), userId: params.userId, month: params.month, nights, complete: false };
  }

  for (const date of dateRange(start, end)) {
    // Published only: an allowance cannot be earned against a roster nobody was
    // ever shown.
    const shifts = await getShifts(params.userId, date);
    const isNight = shifts.some((shift) => earnsNightAllowance(shift));
    if (!isNight) {
      days.push({ scheduled: false, worked: false });
      continue;
    }

    const view = await viewTimecard({
      userId: params.userId,
      date,
      autoGenerate: false,
      actorId: params.actorId,
    });
    // Worked means worked. Paid leave keeps somebody's salary whole and does
    // not put them on a night shift, so it does not earn the allowance.
    const worked = !!view && costTimecard({ rows: view.rows, dayCharacter: 'ORDINARY' }).workedMinutes > 0;
    days.push({ scheduled: true, worked });
    nights.push({ date, worked });
  }

  return { ...nightAllowance(days), userId: params.userId, month: params.month, nights, complete };
}

/** The last day of a `YYYY-MM`, without trusting month lengths to a lookup table. */
function lastDayOf(month: string): DateStr {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
}

/** The Ramadan dates covering a span, for the shorter working day. */
export async function ramadanFor(start: DateStr, end: DateStr): Promise<Set<DateStr>> {
  const days = new Set<DateStr>();
  for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year++) {
    for (const date of ramadanDates(year)) {
      if (date >= start && date <= end) days.add(date);
    }
  }
  return days;
}
