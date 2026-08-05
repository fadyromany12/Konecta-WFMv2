/** Client-side mirrors of the server's time helpers. Same rules, same shapes. */

export function dateOf(stamp: string): string {
  return stamp.slice(0, 10);
}

export function timeOf(stamp: string): string {
  return stamp.slice(11, 16);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function toMinutes(stamp: string): number {
  const [date, time] = [stamp.slice(0, 10), stamp.slice(11, 16)];
  const days = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  return days * 1440 + Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

export function formatDuration(minutes: number): string {
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minutes));
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function durationBetween(from: string, to: string): string {
  return formatDuration(toMinutes(to) - toMinutes(from));
}

/** Replace the time part of a stamp, keeping its date. */
export function withTime(stamp: string, time: string): string {
  return `${stamp.slice(0, 10)} ${time}`;
}

/**
 * Roll dates forward across an ordered list of stamps so that each is at or
 * after the one before it. This is what makes typing `02:30` into an overnight
 * shift land on the following day without the user having to think about it.
 */
export function rollForward(stamps: string[], anchor: string): string[] {
  const out: string[] = [];
  let previous = anchor;
  for (const stamp of stamps) {
    let candidate = `${dateOf(previous)} ${timeOf(stamp)}`;
    if (toMinutes(candidate) < toMinutes(previous)) {
      candidate = `${addDays(dateOf(previous), 1)} ${timeOf(stamp)}`;
    }
    out.push(candidate);
    previous = candidate;
  }
  return out;
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
