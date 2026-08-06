/**
 * The intraday picture — what is happening right now.
 *
 * Everything else in the tool looks backwards: yesterday's card, last week's
 * exceptions. This looks at this minute, because that is the only window in
 * which an intraday coordinator can actually change the outcome. Someone who
 * has not clocked on ten minutes into their shift is recoverable; the same fact
 * discovered tomorrow morning is only paperwork.
 */

import { db } from '../db/index.js';
import { ACTIVITY_MAP } from '../domain/reference.js';
import { toSegments } from '../domain/schedule.js';
import { INTERVAL_MINUTES } from '../domain/forecast.js';
import { addDays, diffMinutes, nowStamp, todayStr, type DateStr, type Stamp } from '../domain/time.js';
import { effectiveShiftRule, placeholders } from './people.js';
import { getShifts } from './scheduling.js';

export type LiveState =
  | 'ON_PHONE'
  | 'OTHER_WORK'
  | 'BREAK'
  | 'LUNCH'
  | 'NOT_CLOCKED_ON'
  | 'LATE'
  | 'OFF_SHIFT'
  | 'CLOCKED_OFF_EARLY';

export interface LivePerson {
  userId: number;
  employeeId: string;
  name: string;
  state: LiveState;
  activity: string | null;
  activityName: string | null;
  since: Stamp | null;
  minutesInState: number;
  scheduledActivity: string | null;
  scheduledStart: Stamp | null;
  scheduledEnd: Stamp | null;
  /** True when what they are doing is not what was planned for right now. */
  outOfAdherence: boolean;
  /** Minutes late clocking on, when that applies. */
  minutesLate: number | null;
}

export interface IntradaySnapshot {
  at: Stamp;
  people: LivePerson[];
  totals: {
    scheduledOn: number;
    clockedOn: number;
    onPhone: number;
    onBreakOrLunch: number;
    notClockedOn: number;
    late: number;
    outOfAdherence: number;
    adherencePct: number;
  };
  alerts: { severity: 'high' | 'medium'; userId: number; name: string; message: string }[];
}

interface PunchRow {
  user_id: number;
  at: Stamp;
  type: string;
  activity: string | null;
}

/**
 * Latest punch per person, looking back far enough to catch an overnight shift
 * that started yesterday evening.
 */
function latestPunches(userIds: number[], now: Stamp): Map<number, PunchRow> {
  if (userIds.length === 0) return new Map();
  const from = `${addDays(now.slice(0, 10), -1)} 00:00`;
  const rows = db
    .prepare(
      `SELECT p.user_id, p.at, p.type, p.activity
       FROM punches p
       WHERE p.user_id IN (${placeholders(userIds.length)})
         AND p.at BETWEEN ? AND ?
       ORDER BY p.at`,
    )
    .all(...userIds, from, now) as PunchRow[];

  const latest = new Map<number, PunchRow>();
  for (const row of rows) latest.set(row.user_id, row); // ordered, so the last wins
  return latest;
}

export function intradaySnapshot(userIds: number[], now: Stamp = nowStamp()): IntradaySnapshot {
  const today = now.slice(0, 10);
  const people: LivePerson[] = [];
  const alerts: IntradaySnapshot['alerts'] = [];

  if (userIds.length === 0) {
    return { at: now, people, totals: emptyTotals(), alerts };
  }

  const users = db
    .prepare(
      `SELECT id, employee_id, name, role FROM users
       WHERE id IN (${placeholders(userIds.length)}) AND role = 'ADVISOR' ORDER BY name`,
    )
    .all(...userIds) as { id: number; employee_id: string; name: string }[];

  const latest = latestPunches(users.map((u) => u.id), now);

  for (const user of users) {
    // A shift that began yesterday evening is still today's business at 02:00.
    const segments = [
      ...getShifts(user.id, addDays(today, -1)).flatMap((s) => toSegments(s)),
      ...getShifts(user.id, today).flatMap((s) => toSegments(s)),
    ].filter((seg) => seg.endAt > `${addDays(today, -1)} 12:00`);

    const current = segments.find((seg) => seg.startAt <= now && seg.endAt > now);
    const shiftStart = segments[0]?.startAt ?? null;
    const shiftEnd = segments[segments.length - 1]?.endAt ?? null;
    const onShift = !!current;

    const punch = latest.get(user.id);
    const clockedOn = !!punch && punch.type !== 'OFF';
    const activity = clockedOn ? punch!.activity : null;
    const meta = activity ? ACTIVITY_MAP.get(activity) : null;

    let state: LiveState;
    let minutesLate: number | null = null;

    if (clockedOn) {
      if (activity === '99-001') state = 'LUNCH';
      else if (activity === '26-001') state = 'BREAK';
      else if (meta?.productive) state = 'ON_PHONE';
      else state = 'OTHER_WORK';
    } else if (onShift) {
      const rule = effectiveShiftRule(user.id, today);
      const late = shiftStart ? diffMinutes(shiftStart, now) : 0;
      if (late > rule.lateGraceMinutes) {
        // Clocked off before the end counts differently to never having arrived.
        state = punch?.type === 'OFF' ? 'CLOCKED_OFF_EARLY' : 'LATE';
        minutesLate = late;
      } else {
        state = 'NOT_CLOCKED_ON';
      }
    } else {
      state = 'OFF_SHIFT';
    }

    const scheduledActivity = current?.activity ?? null;
    const outOfAdherence =
      onShift &&
      (!clockedOn ||
        (!!scheduledActivity && !sameFamily(scheduledActivity, activity)));

    people.push({
      userId: user.id,
      employeeId: user.employee_id,
      name: user.name,
      state,
      activity,
      activityName: meta?.name ?? null,
      since: clockedOn ? punch!.at : null,
      minutesInState: clockedOn ? diffMinutes(punch!.at, now) : 0,
      scheduledActivity: current?.activityName ?? null,
      scheduledStart: shiftStart,
      scheduledEnd: shiftEnd,
      outOfAdherence,
      minutesLate,
    });

    if (state === 'LATE' && minutesLate !== null) {
      alerts.push({
        severity: minutesLate > 15 ? 'high' : 'medium',
        userId: user.id,
        name: user.name,
        message: `${minutesLate} minutes late and not clocked on.`,
      });
    }
    if (state === 'CLOCKED_OFF_EARLY') {
      alerts.push({
        severity: 'high',
        userId: user.id,
        name: user.name,
        message: 'Clocked off while still scheduled to be on shift.',
      });
    }
    if (state === 'LUNCH' || state === 'BREAK') {
      const rule = effectiveShiftRule(user.id, today);
      const allowance = state === 'LUNCH' ? rule.lunchMinutes : 15;
      const over = diffMinutes(punch!.at, now) - allowance;
      if (over > 5) {
        alerts.push({
          severity: over > 15 ? 'high' : 'medium',
          userId: user.id,
          name: user.name,
          message: `${over} minutes over their ${state === 'LUNCH' ? 'meal' : 'break'} allowance.`,
        });
      }
    }
  }

  const scheduledOn = people.filter((p) => p.state !== 'OFF_SHIFT').length;
  const inAdherence = people.filter((p) => p.state !== 'OFF_SHIFT' && !p.outOfAdherence).length;

  return {
    at: now,
    people,
    totals: {
      scheduledOn,
      clockedOn: people.filter((p) => ['ON_PHONE', 'OTHER_WORK', 'BREAK', 'LUNCH'].includes(p.state)).length,
      onPhone: people.filter((p) => p.state === 'ON_PHONE').length,
      onBreakOrLunch: people.filter((p) => p.state === 'BREAK' || p.state === 'LUNCH').length,
      notClockedOn: people.filter((p) => p.state === 'NOT_CLOCKED_ON').length,
      late: people.filter((p) => p.state === 'LATE').length,
      outOfAdherence: people.filter((p) => p.outOfAdherence).length,
      adherencePct: scheduledOn === 0 ? 100 : Math.round((inAdherence / scheduledOn) * 1000) / 10,
    },
    alerts: alerts.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1)),
  };
}

/** Being on any productive activity satisfies a plan to be on a productive one. */
function sameFamily(scheduled: string, actual: string | null): boolean {
  if (!actual) return false;
  if (scheduled === actual) return true;
  const productive = new Set(['01-001', '01-002', '02-001', '03-001', '07-001', '07-002']);
  return productive.has(scheduled) && productive.has(actual);
}

/**
 * Headcount scheduled to be on the phone in each half hour, which is what the
 * forecast's required figure gets compared against.
 */
export function scheduledByInterval(userIds: number[], date: DateStr): Map<string, number> {
  const counts = new Map<string, number>();
  if (userIds.length === 0) return counts;

  for (const userId of userIds) {
    // A shift starting the previous evening still covers this morning.
    const shifts = [...getShifts(userId, addDays(date, -1)), ...getShifts(userId, date)];
    for (const shift of shifts) {
      for (const seg of toSegments(shift)) {
        // Only time on a productive activity answers contacts.
        if (!['SHIFT_START', 'OPEN_TIME', 'EXTRA_HOURS', 'FLEX_UP'].includes(seg.activityKey)) continue;
        for (
          let m = ceilToInterval(seg.startAt);
          m < toMinutesOfDay(seg.endAt, date);
          m += INTERVAL_MINUTES
        ) {
          if (m < 0 || m >= 1440) continue;
          const key = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
  }
  return counts;

  function ceilToInterval(stamp: Stamp): number {
    const mins = toMinutesOfDay(stamp, date);
    return Math.ceil(mins / INTERVAL_MINUTES) * INTERVAL_MINUTES;
  }
}

/** Minutes from midnight of `date`; negative or >1440 when it falls on another day. */
function toMinutesOfDay(stamp: Stamp, date: DateStr): number {
  const dayOffset =
    (Date.parse(stamp.slice(0, 10) + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86400000;
  return dayOffset * 1440 + Number(stamp.slice(11, 13)) * 60 + Number(stamp.slice(14, 16));
}

function emptyTotals(): IntradaySnapshot['totals'] {
  return {
    scheduledOn: 0,
    clockedOn: 0,
    onPhone: 0,
    onBreakOrLunch: 0,
    notClockedOn: 0,
    late: 0,
    outOfAdherence: 0,
    adherencePct: 100,
  };
}

export const INTRADAY_TODAY = todayStr;
