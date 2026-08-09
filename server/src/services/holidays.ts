/**
 * The public holiday calendar as the app holds it.
 *
 * Separate from the pay engine that reads it, and deliberately free of any
 * dependency on timecards, because both the pay service and the timecard
 * service need to ask what a date is and a cycle between them is a real
 * hazard rather than a stylistic one.
 */

import { audit, db, transact } from '../db/index.js';
import { holidaysFor, type Holiday } from '../domain/holidays.js';
import { addDays, todayStr, type DateStr } from '../domain/time.js';

const REGION = 'EG';

interface HolidayRow {
  date: string;
  name: string;
  basis: string;
  confirmed: number;
}

export interface HolidayView extends Holiday {
  /** False while the date is still the calendar's guess rather than a decision. */
  confirmed: boolean;
}

/**
 * Make sure the calendar covers a span of dates.
 *
 * Generated on demand rather than in the seed, so the app does not go blind the
 * first January nobody remembered to top it up.
 *
 * A year is generated **once**, as a whole. Filling in whichever individual
 * dates happened to be missing looks more careful and is worse: Eid al-Fitr
 * announced a day later than the arithmetic calendar guessed means moving the
 * holiday, which deletes the estimate — and a per-date top-up puts it straight
 * back on the next read. The calendar then holds both dates and pays three
 * times the rate on each. Once a year exists it belongs to the people editing
 * it, and the generator does not touch it again.
 *
 * The residual case: an estimate on 31 December moved into 1 January makes the
 * following year look populated by one row, so that year is never generated.
 * It needs a Hijri holiday to fall on New Year's Eve *and* to be announced a
 * day late, and the symptom is a visibly empty calendar rather than a silent
 * overpayment, which is the right way round for it to fail.
 */
export async function ensureHolidays(start: DateStr, end: DateStr): Promise<void> {
  const from = Number(start.slice(0, 4));
  const to = Number(end.slice(0, 4));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 20) return;

  const populated = new Set(
    (
      await db.all<{ year: string }>(
        `SELECT DISTINCT substr(date, 1, 4) AS year FROM public_holidays
         WHERE region = ? AND date BETWEEN ? AND ?`,
        [REGION, `${from}-01-01`, `${to}-12-31`],
      )
    ).map((r) => r.year),
  );

  for (let year = from; year <= to; year++) {
    if (populated.has(String(year))) continue;
    for (const holiday of holidaysFor(year)) {
      await db.run(
        `INSERT INTO public_holidays (date, region, name, basis, confirmed)
         VALUES (?, ?, ?, ?, ?)`,
        [holiday.date, REGION, holiday.name, holiday.basis, holiday.estimated ? 0 : 1],
      );
    }
  }
}

export async function listHolidays(start: DateStr, end: DateStr): Promise<HolidayView[]> {
  await ensureHolidays(start, end);
  const rows = await db.all<HolidayRow>(
    `SELECT date, name, basis, confirmed FROM public_holidays
     WHERE region = ? AND date BETWEEN ? AND ? ORDER BY date`,
    [REGION, start, end],
  );
  return rows.map((row) => ({
    date: row.date,
    name: row.name,
    basis: row.basis as Holiday['basis'],
    estimated: !row.confirmed,
    confirmed: !!row.confirmed,
  }));
}

/** The dates that pay a holiday rate, as a set the domain can ask questions of. */
export async function holidayDates(start: DateStr, end: DateStr): Promise<Set<DateStr>> {
  return new Set((await listHolidays(start, end)).map((h) => h.date));
}

/**
 * Confirm or move a holiday.
 *
 * Both operations in one place because they are the same act: somebody who
 * knows is replacing an estimate with a decision. Moving a date deletes the
 * estimate rather than leaving both, because two Eids in one week would cost
 * six times the rate.
 */
export async function settleHoliday(params: {
  date: DateStr;
  actualDate?: DateStr;
  name?: string;
  actorId: number;
}): Promise<{ ok: boolean; message: string }> {
  const row = await db.get<HolidayRow>(
    'SELECT date, name, basis, confirmed FROM public_holidays WHERE region = ? AND date = ?',
    [REGION, params.date],
  );
  if (!row) return { ok: false, message: `${params.date} is not in the holiday calendar.` };

  const moved = params.actualDate && params.actualDate !== params.date;
  if (moved) {
    const clash = await db.get<{ date: string }>(
      'SELECT date FROM public_holidays WHERE region = ? AND date = ?',
      [REGION, params.actualDate!],
    );
    if (clash) {
      return { ok: false, message: `${params.actualDate} is already a public holiday.` };
    }
  }

  await transact(async () => {
    if (moved) {
      await db.run('DELETE FROM public_holidays WHERE region = ? AND date = ?', [REGION, params.date]);
      await db.run(
        `INSERT INTO public_holidays (date, region, name, basis, confirmed, confirmed_by)
         VALUES (?, ?, ?, ?, 1, ?)`,
        [params.actualDate, REGION, params.name ?? row.name, row.basis, params.actorId],
      );
    } else {
      await db.run(
        'UPDATE public_holidays SET confirmed = 1, confirmed_by = ?, name = ? WHERE region = ? AND date = ?',
        [params.actorId, params.name ?? row.name, REGION, params.date],
      );
    }
    await audit(params.actorId, 'holiday', params.date, moved ? 'MOVE' : 'CONFIRM', {
      to: params.actualDate ?? params.date,
      name: params.name ?? row.name,
    });
  });

  return {
    ok: true,
    message: moved
      ? `${row.name} moved to ${params.actualDate} and confirmed.`
      : `${row.name} confirmed on ${params.date}.`,
  };
}

/** Holidays close enough to matter, for the planning screens. */
export async function upcomingHolidays(days = 90): Promise<HolidayView[]> {
  const today = todayStr();
  return listHolidays(today, addDays(today, days));
}
