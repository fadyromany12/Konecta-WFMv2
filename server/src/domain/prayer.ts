/**
 * Prayer times, and what a roster owes them.
 *
 * Computed rather than tabulated. A table would need maintaining for every year
 * and every site, and would be wrong the first time somebody opened a second
 * centre — the times move by nearly two hours across a year and differ between
 * Cairo and Alexandria.
 *
 * The convention is the Egyptian General Authority of Survey's, which is the
 * one Egyptian mosques and published calendars use: Fajr at 19.5° and Isha at
 * 17.5° below the horizon, Asr at a shadow ratio of one. Getting the convention
 * right matters more than getting the arithmetic to the second — a time that is
 * two minutes out is fine, and one computed with the wrong convention is
 * twenty minutes out and visibly not what the calendar on the wall says.
 *
 * Only three of the five ever land inside a working day on a normal roster, and
 * one of them carries far more weight than the others: during Ramadan, Maghrib
 * is iftar. An advisor on shift at sunset in Ramadan has not eaten or drunk
 * since dawn, and a roster that puts their break an hour after sunset is not a
 * scheduling inconvenience.
 */

import type { DateStr } from './time.js';

export interface Site {
  latitude: number;
  longitude: number;
  /**
   * Hours ahead of UTC, as a number for a place that does not change, or as a
   * function of the date for one that does.
   *
   * This is not a detail. Computed against a fixed +2, Cairo's midsummer sunset
   * came out at 18:59 against a published 19:57 — an hour out, every day from
   * late April to late October, which is precisely the half of the year when
   * Ramadan iftar matters most in a long evening shift.
   */
  utcOffset: number | ((date: DateStr) => number);
}

/**
 * Egypt's summer time.
 *
 * Reintroduced in 2023 after a nine-year gap: clocks go forward on the last
 * Friday of April and back on the last Thursday of October. Written as a rule
 * rather than a table so it does not need revisiting every December, and
 * deliberately not read from the host's timezone database — the server runs in
 * UTC, and a roster's prayer times must not depend on where it is deployed.
 */
export function egyptUtcOffset(date: DateStr): number {
  const [year, month, day] = date.split('-').map(Number);
  // Abolished in 2015 and reintroduced in 2023, so a date in between is on
  // standard time all year. This only matters for reading historical rosters,
  // but a function that answered +3 for July 2020 would be quietly wrong and
  // there is no cost to being right.
  if (year < 2023) return 2;
  const start = lastWeekdayOf(year, 4, 5); // last Friday of April
  const end = lastWeekdayOf(year, 10, 4); // last Thursday of October
  const asNumber = month * 100 + day;
  return asNumber >= start && asNumber < end ? 3 : 2;
}

/** `MMDD` of the last given weekday in a month. 0 is Sunday. */
function lastWeekdayOf(year: number, month: number, weekday: number): number {
  const last = new Date(Date.UTC(year, month, 0));
  const back = (last.getUTCDay() - weekday + 7) % 7;
  const day = last.getUTCDate() - back;
  return month * 100 + day;
}

function offsetFor(site: Site, date: DateStr): number {
  return typeof site.utcOffset === 'function' ? site.utcOffset(date) : site.utcOffset;
}

/** Cairo, and the default for a deployment that has not said otherwise. */
export const CAIRO: Site = {
  latitude: 30.0444,
  longitude: 31.2357,
  utcOffset: egyptUtcOffset,
};

export type PrayerName = 'FAJR' | 'SUNRISE' | 'DHUHR' | 'ASR' | 'MAGHRIB' | 'ISHA';

export const PRAYER_LABELS: Record<PrayerName, string> = {
  FAJR: 'Fajr',
  SUNRISE: 'Sunrise',
  DHUHR: 'Dhuhr',
  ASR: 'Asr',
  MAGHRIB: 'Maghrib',
  ISHA: 'Isha',
};

/** Egyptian General Authority of Survey. */
const FAJR_ANGLE = 19.5;
const ISHA_ANGLE = 17.5;
/** Standard refraction-and-radius allowance for the sun's upper limb. */
const HORIZON = 0.833;

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Days since J2000.0 for a date at noon UTC. */
function julianDays(date: DateStr): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 12) / 86400000 - 10957.5;
}

/**
 * The sun's declination and the equation of time.
 *
 * The low-precision expressions from the Astronomical Almanac: good to about a
 * hundredth of a degree, which is far inside the minute that matters here.
 */
function sun(date: DateStr): { declination: number; equationOfTime: number } {
  const n = julianDays(date);
  const meanLongitude = (280.459 + 0.98564736 * n) % 360;
  const meanAnomaly = rad((357.529 + 0.98560028 * n) % 360);
  const eclipticLongitude = rad(
    meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly),
  );
  const obliquity = rad(23.439 - 0.00000036 * n);

  const declination = deg(Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude)));
  let rightAscension = deg(
    Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude)),
  );
  rightAscension = ((rightAscension % 360) + 360) % 360;

  // In minutes. Wrapped into ±20 because the two longitudes can be a whole
  // turn apart around the new year, which would otherwise put noon in the
  // middle of the night once a year.
  let equationOfTime = (meanLongitude - rightAscension) * 4;
  if (equationOfTime > 20) equationOfTime -= 1440;
  if (equationOfTime < -20) equationOfTime += 1440;
  return { declination, equationOfTime };
}

/** Hour angle, in hours, for the sun at a given altitude below the horizon. */
function hourAngle(angle: number, latitude: number, declination: number): number | null {
  const cosH =
    (-Math.sin(rad(angle)) - Math.sin(rad(latitude)) * Math.sin(rad(declination))) /
    (Math.cos(rad(latitude)) * Math.cos(rad(declination)));
  // At high latitudes the sun never reaches the angle, so the prayer has no
  // time by this method. Egypt never sees it; returning null rather than NaN
  // is what keeps a deployment further north from rendering "NaN:NaN".
  if (cosH > 1 || cosH < -1) return null;
  return deg(Math.acos(cosH)) / 15;
}

function toClock(hours: number): string {
  const wrapped = ((hours % 24) + 24) % 24;
  const total = Math.round(wrapped * 60);
  const hh = Math.floor(total / 60) % 24;
  return `${String(hh).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export interface PrayerTimes {
  date: DateStr;
  times: { name: PrayerName; at: string }[];
}

export function prayerTimes(date: DateStr, site: Site = CAIRO): PrayerTimes {
  const { declination, equationOfTime } = sun(date);
  const noon = 12 + offsetFor(site, date) - site.longitude / 15 - equationOfTime / 60;

  const at = (angle: number, sign: 1 | -1): string | null => {
    const h = hourAngle(angle, site.latitude, declination);
    return h === null ? null : toClock(noon + sign * h);
  };

  // Asr is defined by shadow length rather than by the sun's altitude: the
  // moment an object's shadow equals its own length plus its noon shadow.
  const asrAltitude = deg(
    Math.atan(1 / (1 + Math.tan(Math.abs(rad(site.latitude - declination))))),
  );

  const entries: [PrayerName, string | null][] = [
    ['FAJR', at(FAJR_ANGLE, -1)],
    ['SUNRISE', at(HORIZON, -1)],
    ['DHUHR', toClock(noon)],
    ['ASR', at(-asrAltitude, 1)],
    ['MAGHRIB', at(HORIZON, 1)],
    ['ISHA', at(ISHA_ANGLE, 1)],
  ];

  return {
    date,
    times: entries
      .filter((e): e is [PrayerName, string] => e[1] !== null)
      .map(([name, time]) => ({ name, at: time })),
  };
}

/**
 * How close a break has to be to count as covering a prayer.
 *
 * Twenty minutes either side. Prayer takes a few minutes and there is latitude
 * about exactly when within the window it is performed, so demanding the break
 * start on the minute would report almost every shift as a breach and the
 * warning would be ignored within a week.
 */
export const PRAYER_GRACE_MINUTES = 20;

/** Iftar is the moment of Maghrib. Nothing else in the day moves for it. */
export const IFTAR_PRAYER: PrayerName = 'MAGHRIB';

const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

export interface BreakWindow {
  /** Clock time the break starts. */
  startTime: string;
  minutes: number;
}

export interface PrayerCoverage {
  prayer: PrayerName;
  at: string;
  covered: boolean;
  /** How far the nearest break is, in minutes. Null when there are none. */
  nearestBreakMinutes: number | null;
}

/**
 * Which prayers falling inside a shift have a break near them.
 *
 * Deliberately reports rather than refuses. Prayer is an accommodation a floor
 * makes, not a statutory limit like the eleven-hour rest — and there are
 * genuinely days where the queue wins. Blocking a save would mean planners
 * route around the tool; showing them what they are about to do means they can
 * decide, and see it.
 */
export function prayerCoverage(params: {
  date: DateStr;
  shiftStart: string;
  shiftEnd: string;
  breaks: BreakWindow[];
  site?: Site;
  /** Restrict to the prayers worth checking; defaults to those inside a day. */
  prayers?: PrayerName[];
}): PrayerCoverage[] {
  const times = prayerTimes(params.date, params.site).times;
  const wanted = new Set<PrayerName>(params.prayers ?? ['DHUHR', 'ASR', 'MAGHRIB']);

  const start = minutesOf(params.shiftStart);
  // An overnight shift ends on a later clock reading than it starts; add a day
  // so "23:00 to 07:30" contains 02:00 rather than nothing at all.
  const end = minutesOf(params.shiftEnd) <= start ? minutesOf(params.shiftEnd) + 1440 : minutesOf(params.shiftEnd);

  const out: PrayerCoverage[] = [];

  for (const { name, at } of times) {
    if (!wanted.has(name)) continue;
    const raw = minutesOf(at);
    const candidates = [raw, raw + 1440];
    const inShift = candidates.find((m) => m >= start && m <= end);
    if (inShift === undefined) continue;

    let nearest: number | null = null;
    for (const brk of params.breaks) {
      const brkStart = minutesOf(brk.startTime);
      for (const b of [brkStart, brkStart + 1440]) {
        // Distance to the break *window*, not to its start: a thirty minute
        // break beginning ten minutes before Maghrib covers it.
        const distance = inShift < b ? b - inShift : Math.max(0, inShift - (b + brk.minutes));
        if (nearest === null || distance < nearest) nearest = distance;
      }
    }

    out.push({
      prayer: name,
      at,
      covered: nearest !== null && nearest <= PRAYER_GRACE_MINUTES,
      nearestBreakMinutes: nearest,
    });
  }

  return out;
}

/**
 * The one that is worth a warning on its own.
 *
 * Outside Ramadan an uncovered Dhuhr is worth noting. Inside it, an uncovered
 * Maghrib means somebody breaks a fast at their desk between calls, and that is
 * a different order of thing.
 */
export function iftarWarning(coverage: PrayerCoverage[], isRamadan: boolean): string | null {
  const maghrib = coverage.find((c) => c.prayer === IFTAR_PRAYER);
  if (!maghrib || maghrib.covered) return null;
  if (!isRamadan) {
    return `Maghrib falls at ${maghrib.at} during this shift with no break within ${PRAYER_GRACE_MINUTES} minutes.`;
  }
  const late = maghrib.nearestBreakMinutes;
  return (
    `Iftar is at ${maghrib.at} and the nearest break is ${late === null ? 'not scheduled at all' : `${late} minutes away`}. ` +
    'During Ramadan this is the break that matters most — nobody on this shift will have eaten since dawn.'
  );
}
