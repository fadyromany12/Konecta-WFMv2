/**
 * The Egyptian public holiday calendar.
 *
 * Three kinds of holiday, and they differ in how much the code is allowed to
 * claim about them:
 *
 * - **Fixed Gregorian.** 25 January, 1 May, 6 October and the rest. Same date
 *   every year, derivable, certain.
 * - **Coptic.** Christmas on 7 January, and Sham El-Nessim on the Monday after
 *   Orthodox Easter. Orthodox Easter is a computation, not an observation, so
 *   these are certain too.
 * - **Islamic.** The two Eids, the Islamic New Year, the Prophet's Birthday.
 *   These are *not* certain. Egypt's Dar al-Ifta announces them on sighting,
 *   and the arithmetic Umm al-Qura calendar this module uses to place them can
 *   be a day out in either direction.
 *
 * So the Islamic dates come back marked `estimated`, and the rest do not. That
 * distinction is the entire reason this file has a type rather than just a list
 * of strings: an estimated date driving a triple-time payment is a real cost
 * error, and the only safe thing to do with one is show it as provisional until
 * somebody who knows confirms it.
 *
 * Egypt also grants a day off in lieu when a public holiday falls on a weekly
 * rest day. That is a rostering consequence rather than a calendar fact and is
 * not decided here.
 */

import { addDays, type DateStr } from './time.js';

export type HolidayBasis = 'GREGORIAN' | 'COPTIC' | 'ISLAMIC';

export interface Holiday {
  date: DateStr;
  name: string;
  basis: HolidayBasis;
  /**
   * True when the date is derived from a calendar that Egypt settles by
   * observation, so it may move by a day. Estimated dates must be confirmed
   * before anything is paid against them.
   */
  estimated: boolean;
}

/** Day and month in the Gregorian year, with the name Egypt uses. */
const FIXED: Array<{ month: number; day: number; name: string; basis: HolidayBasis }> = [
  { month: 1, day: 7, name: 'Coptic Christmas', basis: 'COPTIC' },
  { month: 1, day: 25, name: 'Revolution Day and National Police Day', basis: 'GREGORIAN' },
  { month: 4, day: 25, name: 'Sinai Liberation Day', basis: 'GREGORIAN' },
  { month: 5, day: 1, name: 'Labour Day', basis: 'GREGORIAN' },
  { month: 6, day: 30, name: '30 June Revolution', basis: 'GREGORIAN' },
  { month: 7, day: 23, name: 'Revolution Day', basis: 'GREGORIAN' },
  { month: 10, day: 6, name: 'Armed Forces Day', basis: 'GREGORIAN' },
];

/**
 * Islamic holidays as (month, day) in the Hijri year, with how many days the
 * public holiday runs for. Eid al-Fitr is three days from 1 Shawwal; Eid
 * al-Adha is four from 10 Dhu al-Hijjah, and Arafat the day before it is
 * commonly taken as well.
 */
const ISLAMIC: Array<{ month: number; day: number; days: number; name: string }> = [
  { month: 10, day: 1, days: 3, name: 'Eid al-Fitr' },
  { month: 12, day: 9, days: 5, name: 'Eid al-Adha' },
  { month: 1, day: 1, days: 1, name: 'Islamic New Year' },
  { month: 3, day: 12, days: 1, name: "Prophet's Birthday" },
];

/**
 * Every public holiday in a Gregorian year.
 *
 * Islamic holidays are found by scanning the year for the Hijri date rather
 * than converting, because a Hijri year does not line up with a Gregorian one
 * and the same Islamic holiday can therefore appear twice in one Gregorian year
 * or not at all. Scanning finds however many there are.
 */
export function holidaysFor(year: number): Holiday[] {
  const out: Holiday[] = [];

  for (const entry of FIXED) {
    out.push({
      date: `${year}-${pad(entry.month)}-${pad(entry.day)}`,
      name: entry.name,
      basis: entry.basis,
      estimated: false,
    });
  }

  const easter = orthodoxEaster(year);
  out.push({
    date: addDays(easter, 1),
    name: 'Sham El-Nessim',
    basis: 'COPTIC',
    estimated: false,
  });

  for (const entry of ISLAMIC) {
    for (const start of hijriDatesIn(year, entry.month, entry.day)) {
      for (let i = 0; i < entry.days; i++) {
        out.push({
          date: addDays(start, i),
          name: entry.days > 1 ? `${entry.name}, day ${i + 1}` : entry.name,
          basis: 'ISLAMIC',
          estimated: true,
        });
      }
    }
  }

  // A holiday falling on another holiday is one day off, not two — but it is
  // still both holidays, and dropping one of them loses a name somebody is
  // expecting to see. Sham El-Nessim lands on Sinai Liberation Day in 2033;
  // keeping only the first meant that year had no Sham El-Nessim at all.
  //
  // A merged date is only estimated when *everything* on it is: one certain
  // holiday is enough to fix the day, whatever an Eid estimate says about it.
  const byDate = new Map<DateStr, Holiday>();
  for (const holiday of out) {
    const existing = byDate.get(holiday.date);
    if (!existing) {
      byDate.set(holiday.date, { ...holiday });
      continue;
    }
    byDate.set(holiday.date, {
      date: holiday.date,
      name: existing.name === holiday.name ? existing.name : `${existing.name} and ${holiday.name}`,
      basis: existing.estimated && !holiday.estimated ? holiday.basis : existing.basis,
      estimated: existing.estimated && holiday.estimated,
    });
  }

  return [...byDate.values()]
    .filter((h) => h.date.startsWith(String(year)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function holidayRange(fromYear: number, toYear: number): Holiday[] {
  const out: Holiday[] = [];
  for (let year = fromYear; year <= toYear; year++) out.push(...holidaysFor(year));
  return out;
}

/**
 * Every Gregorian date in `year` that is the given Hijri day and month.
 *
 * Steps a day at a time rather than trying to invert the conversion. A year is
 * 365 formatter calls, which is nothing against getting the arithmetic of two
 * calendars wrong, and it is only ever run when a year's calendar is built.
 */
function hijriDatesIn(year: number, hijriMonth: number, hijriDay: number): DateStr[] {
  if (!HIJRI_AVAILABLE) return [];
  const out: DateStr[] = [];
  const end = `${year}-12-31`;
  for (let date = `${year}-01-01`; date <= end; date = addDays(date, 1)) {
    const hijri = toHijri(date);
    if (hijri.month === hijriMonth && hijri.day === hijriDay) out.push(date);
  }
  return out;
}

const HIJRI = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  timeZone: 'UTC',
});

/**
 * Whether this runtime can actually do the conversion.
 *
 * A Node build without full ICU accepts the locale and quietly ignores the
 * calendar, so every date comes back Gregorian — and 1 Shawwal becomes 1
 * October. That failure is invisible: the calendar looks populated, the dates
 * look plausible, and Eid is on the wrong day at three times the rate. Checking
 * what the formatter actually resolved to is the difference between no Islamic
 * holidays and wrong ones, and no is much the better answer.
 */
const HIJRI_AVAILABLE = HIJRI.resolvedOptions().calendar === 'islamic-umalqura';

function toHijri(date: DateStr): { year: number; month: number; day: number } {
  const parts = HIJRI.formatToParts(new Date(`${date}T12:00:00Z`));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * Orthodox Easter, which Sham El-Nessim follows.
 *
 * Meeus's Julian algorithm gives the date in the Julian calendar; Egypt keeps
 * the Gregorian one, and the gap between them is 13 days for all of the 20th
 * and 21st centuries. Computed rather than hard-coded so the calendar does not
 * silently stop being right in 2100.
 */
function orthodoxEaster(year: number): DateStr {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  const julian = `${year}-${pad(month)}-${pad(day)}`;
  return addDays(julian, julianOffset(year));
}

/** Days to add to a Julian date to reach the Gregorian one, for a given year. */
function julianOffset(year: number): number {
  const century = Math.floor(year / 100);
  return century - Math.floor(century / 4) - 2;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
