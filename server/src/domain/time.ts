/**
 * Time primitives for Konecta Pulse.
 *
 * Every instant in the system is stored as a naive local timestamp string
 * `YYYY-MM-DD HH:MM` and every date as `YYYY-MM-DD`. We deliberately avoid
 * JavaScript `Date` + timezone arithmetic: a contact centre shift is a wall
 * clock concept, and an advisor scheduled 23:00-07:30 works that wall clock
 * regardless of what daylight saving does underneath. Storing naive strings
 * keeps schedules, timecards and payroll dates all agreeing with each other.
 */

export type DateStr = string; // YYYY-MM-DD
export type TimeStr = string; // HH:MM (24 hour, leading zero required)
export type Stamp = string; // YYYY-MM-DD HH:MM

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):([0-5]\d)$/;

export function isDate(v: unknown): v is DateStr {
  return typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
}

/** 24 hour clock with a mandatory leading zero, exactly as the tool requires on entry. */
export function isTime(v: unknown): v is TimeStr {
  return typeof v === 'string' && TIME_RE.test(v);
}

export function isStamp(v: unknown): v is Stamp {
  return typeof v === 'string' && STAMP_RE.test(v);
}

export function stamp(date: DateStr, time: TimeStr): Stamp {
  return `${date} ${time}`;
}

export function dateOf(s: Stamp): DateStr {
  return s.slice(0, 10);
}

export function timeOf(s: Stamp): TimeStr {
  return s.slice(11, 16);
}

/** Minutes since 1970-01-01 00:00 local. Comparable and subtractable. */
export function toMinutes(s: Stamp): number {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const hh = Number(s.slice(11, 13));
  const mm = Number(s.slice(14, 16));
  return Math.floor(Date.UTC(y, m - 1, d) / 60000) + hh * 60 + mm;
}

export function fromMinutes(mins: number): Stamp {
  const days = Math.floor(mins / 1440);
  const rem = mins - days * 1440;
  const base = new Date(days * 86400000);
  const date = base.toISOString().slice(0, 10);
  const hh = String(Math.floor(rem / 60)).padStart(2, '0');
  const mm = String(rem % 60).padStart(2, '0');
  return `${date} ${hh}:${mm}`;
}

export function addMinutes(s: Stamp, mins: number): Stamp {
  return fromMinutes(toMinutes(s) + mins);
}

export function addDays(date: DateStr, days: number): DateStr {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffMinutes(from: Stamp, to: Stamp): number {
  return toMinutes(to) - toMinutes(from);
}

export function diffDays(from: DateStr, to: DateStr): number {
  return Math.round(
    (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000,
  );
}

/** `HH:MM` rendering of a duration in minutes, the format used on timecards. */
export function formatDuration(mins: number): string {
  const sign = mins < 0 ? '-' : '';
  const abs = Math.abs(Math.round(mins));
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Resolve a bare `HH:MM` typed into a schedule or timecard row onto a concrete
 * date. Rows are entered relative to the shift, so a time earlier than the
 * previous row's time means the shift has rolled past midnight and the date
 * increments — this is what lets a user type `02:30` into a 23:00 shift and
 * get the following calendar day without thinking about it.
 */
export function resolveAfter(previous: Stamp, time: TimeStr): Stamp {
  const sameDay = stamp(dateOf(previous), time);
  if (toMinutes(sameDay) >= toMinutes(previous)) return sameDay;
  return stamp(addDays(dateOf(previous), 1), time);
}

export function todayStr(now: Date = new Date()): DateStr {
  return localParts(now).date;
}

export function nowStamp(now: Date = new Date()): Stamp {
  const p = localParts(now);
  return `${p.date} ${p.time}`;
}

function localParts(now: Date): { date: DateStr; time: TimeStr } {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return { date: `${y}-${m}-${d}`, time: `${hh}:${mm}` };
}

/** Inclusive list of dates between two dates. */
export function dateRange(start: DateStr, end: DateStr): DateStr[] {
  const out: DateStr[] = [];
  for (let d = start; diffDays(d, end) >= 0; d = addDays(d, 1)) {
    out.push(d);
    if (out.length > 400) break; // guard against a runaway range
  }
  return out;
}
