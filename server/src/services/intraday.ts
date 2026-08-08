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
import {
  ACTIVITY_MAP,
  DEFAULT_SHIFT_RULE,
  SHIFT_RULE_MAP,
  type ShiftRule,
} from '../domain/reference.js';
import { activeShift, shiftSpan, toSegments } from '../domain/schedule.js';
import { INTERVAL_MINUTES } from '../domain/forecast.js';
import { addDays, diffMinutes, nowStamp, todayStr, type DateStr, type Stamp } from '../domain/time.js';
import { placeholders } from './people.js';
import { alertAcks } from './planning.js';
import { getShiftsFor } from './scheduling.js';

/**
 * Past this much of a shift with no punch at all, the board stops calling it
 * lateness. Two hours is long enough that a traffic jam or a slow start is no
 * longer the likely explanation.
 */
const NO_SHOW_AFTER_MINUTES = 120;

export type LiveState =
  | 'ON_PHONE'
  | 'OTHER_WORK'
  | 'BREAK'
  | 'LUNCH'
  | 'NOT_CLOCKED_ON'
  | 'LATE'
  | 'NO_SHOW'
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
  alerts: {
    /**
     * Stable identity for this alert: the person, the kind of problem and the
     * day. The list itself is rebuilt on every read, so an acknowledgement has
     * to key off something that survives the rebuild.
     */
    key: string;
    severity: 'high' | 'medium';
    userId: number;
    name: string;
    message: string;
    /** Set when a supervisor has taken responsibility for it. */
    ackedBy?: string | null;
  }[];
}

interface PunchRow {
  user_id: number;
  at: Stamp;
  type: string;
  activity: string | null;
}

/**
 * Shift rules for many people at once.
 *
 * `effectiveShiftRule` is two queries per person, which is the right shape when
 * one card is being looked at and the wrong one when a whole team is on screen.
 */
async function shiftRulesFor(userIds: number[], date: DateStr): Promise<Map<number, ShiftRule>> {
  const out = new Map<number, ShiftRule>();
  if (userIds.length === 0) return out;

  const [users, changes] = await Promise.all([
    db.all<{ id: number; shift_rule: string }>(
      `SELECT id, shift_rule FROM users WHERE id IN (${placeholders(userIds.length)})`,
      userIds,
    ),
    db.all<{ user_id: number; shift_rule: string }>(
      `SELECT user_id, shift_rule FROM shift_rule_changes
       WHERE user_id IN (${placeholders(userIds.length)}) AND effective_date <= ?
       ORDER BY effective_date, id`,
      [...userIds, date],
    ),
  ]);

  // Ordered ascending, so the last change on or before the date wins.
  const latestChange = new Map<number, string>();
  for (const change of changes) latestChange.set(change.user_id, change.shift_rule);

  const fallback = SHIFT_RULE_MAP.get(DEFAULT_SHIFT_RULE)!;
  for (const user of users) {
    const code = latestChange.get(user.id) ?? user.shift_rule ?? DEFAULT_SHIFT_RULE;
    out.set(user.id, SHIFT_RULE_MAP.get(code) ?? fallback);
  }
  return out;
}

/**
 * Latest punch per person, looking back far enough to catch an overnight shift
 * that started yesterday evening.
 */
async function latestPunches(userIds: number[], now: Stamp): Promise<Map<number, PunchRow>> {
  if (userIds.length === 0) return new Map();
  const from = `${addDays(now.slice(0, 10), -1)} 00:00`;
  const rows = await db.all<PunchRow>(
    `SELECT p.user_id, p.at, p.type, p.activity
     FROM punches p
     WHERE p.user_id IN (${placeholders(userIds.length)})
       AND p.at BETWEEN ? AND ?
     ORDER BY p.at`,
    [...userIds, from, now],
  );

  const latest = new Map<number, PunchRow>();
  for (const row of rows) latest.set(row.user_id, row); // ordered, so the last wins
  return latest;
}

export async function intradaySnapshot(
  userIds: number[],
  now: Stamp = nowStamp(),
): Promise<IntradaySnapshot> {
  const today = now.slice(0, 10);
  const people: LivePerson[] = [];
  const alerts: IntradaySnapshot['alerts'] = [];

  if (userIds.length === 0) {
    return { at: now, people, totals: emptyTotals(), alerts };
  }

  const users = await db.all<{ id: number; employee_id: string; name: string }>(
    `SELECT id, employee_id, name, role FROM users
     WHERE id IN (${placeholders(userIds.length)}) AND role = 'ADVISOR' ORDER BY name`,
    userIds,
  );

  const ids = users.map((u) => u.id);
  const yesterday = addDays(today, -1);
  // Everything this loop needs, read up front. Reaching into the database from
  // inside the per-person loop would make drawing one board a query per person.
  const [latest, shiftsByKey, rules] = await Promise.all([
    latestPunches(ids, now),
    getShiftsFor(ids, [yesterday, today]),
    shiftRulesFor(ids, today),
  ]);

  for (const user of users) {
    // A shift that began yesterday evening is still today's business at 02:00,
    // so both days are in scope — but each shift keeps its own span.
    //
    // Flattening the two days into one list of segments and taking the first
    // was wrong in a way that only showed up on the screen: an advisor who
    // worked yesterday and is due on again today had their lateness measured
    // against yesterday's start, and the board reported them "1833 minutes
    // late" — a shift that finished thirty hours ago. Lateness has to be
    // measured against the shift the advisor is actually late for.
    const shifts = [
      ...(shiftsByKey.get(`${user.id}|${yesterday}`) ?? []),
      ...(shiftsByKey.get(`${user.id}|${today}`) ?? []),
    ].filter((shift) => shiftSpan(shift).endAt > `${yesterday} 12:00`);

    const active = activeShift(shifts, now, today);
    const span = active ? shiftSpan(active) : null;
    const segments = active ? toSegments(active) : [];
    const current = segments.find((seg) => seg.startAt <= now && seg.endAt > now);
    const shiftStart = span?.startAt ?? null;
    const shiftEnd = span?.endAt ?? null;
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
      const rule = rules.get(user.id)!;
      const late = shiftStart ? diffMinutes(shiftStart, now) : 0;
      if (late > rule.lateGraceMinutes) {
        // Clocked off before the end counts differently to never having arrived.
        // And past a point, "late" stops being the truth: somebody who was due
        // at nine and has not appeared by four is not running late, they have
        // not come in. Calling that "401 minutes late" is arithmetic rather
        // than information, and it is a different conversation for the
        // supervisor — chasing versus covering the shift.
        if (punch?.type === 'OFF') state = 'CLOCKED_OFF_EARLY';
        else state = late >= NO_SHOW_AFTER_MINUTES ? 'NO_SHOW' : 'LATE';
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
        key: `late:${user.id}:${today}`,
        severity: minutesLate > 15 ? 'high' : 'medium',
        userId: user.id,
        name: user.name,
        message: `${minutesLate} minutes late and not clocked on.`,
      });
    }
    if (state === 'NO_SHOW') {
      // Always high: this one is not going to resolve itself, and the shift
      // still needs covering.
      alerts.push({
        key: `no-show:${user.id}:${today}`,
        severity: 'high',
        userId: user.id,
        name: user.name,
        message: `has not clocked on at all${shiftStart ? `, due ${shiftStart.slice(11)}` : ''}. Cover the shift.`,
      });
    }
    if (state === 'CLOCKED_OFF_EARLY') {
      alerts.push({
        key: `left-early:${user.id}:${today}`,
        severity: 'high',
        userId: user.id,
        name: user.name,
        message: 'Clocked off while still scheduled to be on shift.',
      });
    }
    if (state === 'LUNCH' || state === 'BREAK') {
      const rule = rules.get(user.id)!;
      const allowance = state === 'LUNCH' ? rule.lunchMinutes : 15;
      const over = diffMinutes(punch!.at, now) - allowance;
      if (over > 5) {
        alerts.push({
          key: `over-${state.toLowerCase()}:${user.id}:${today}`,
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

  // Anything a supervisor has already picked up is marked and sorted to the
  // bottom: still visible, because it is not resolved, but out of the way of
  // the ones nobody has taken yet.
  const acks = await alertAcks(today);
  for (const alert of alerts) alert.ackedBy = acks.get(alert.key)?.ackedByName ?? null;
  alerts.sort((a, b) => Number(!!a.ackedBy) - Number(!!b.ackedBy));

  return {
    at: now,
    people,
    totals: {
      scheduledOn,
      clockedOn: people.filter((p) => ['ON_PHONE', 'OTHER_WORK', 'BREAK', 'LUNCH'].includes(p.state)).length,
      onPhone: people.filter((p) => p.state === 'ON_PHONE').length,
      onBreakOrLunch: people.filter((p) => p.state === 'BREAK' || p.state === 'LUNCH').length,
      notClockedOn: people.filter((p) => p.state === 'NOT_CLOCKED_ON').length,
      late: people.filter((p) => p.state === 'LATE' || p.state === 'NO_SHOW').length,
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
export async function scheduledByInterval(userIds: number[], date: DateStr): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (userIds.length === 0) return counts;

  const previous = addDays(date, -1);
  const shiftsByKey = await getShiftsFor(userIds, [previous, date]);

  for (const userId of userIds) {
    // A shift starting the previous evening still covers this morning.
    const shifts = [
      ...(shiftsByKey.get(`${userId}|${previous}`) ?? []),
      ...(shiftsByKey.get(`${userId}|${date}`) ?? []),
    ];
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
