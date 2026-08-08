/**
 * The web clock.
 *
 * Two rules do most of the work here and both exist to stop time being
 * recorded that nobody planned or approved: an advisor may only clock on inside
 * their scheduled window, and once on an unpaid meal they cannot return to a
 * productive activity until the meal duration has actually elapsed.
 */

import { audit, db } from '../db/index.js';
import { ACTIVITY_MAP } from '../domain/reference.js';
import { clockOnWindow, toSegments } from '../domain/schedule.js';
import { addDays, diffMinutes, nowStamp, todayStr, type DateStr, type Stamp } from '../domain/time.js';
import { effectiveShiftRule, getUser } from './people.js';
import { getShifts } from './scheduling.js';
import { generateTimecard } from './timecards.js';
import { emit, notify, supervisorsOf } from './events.js';

export interface ClockState {
  clockedOn: boolean;
  since: Stamp | null;
  activity: string | null;
  activityName: string | null;
  /** The payroll date the current shift belongs to. */
  payrollDate: DateStr | null;
  scheduledStart: Stamp | null;
  scheduledEnd: Stamp | null;
  canClockOn: boolean;
  message: string;
  /** Set while an unpaid meal is still running its minimum duration. */
  mealLockUntil: Stamp | null;
  todaySegments: { activity: string; name: string; startAt: Stamp; endAt: Stamp | null }[];
  availableActivities: { code: string; name: string; family: string }[];
}

/**
 * Which payroll date "now" belongs to. An overnight shift started yesterday is
 * still yesterday's payroll date at 03:00, so we look back a day before
 * defaulting to today.
 */
export async function currentPayrollDate(userId: number, now: Stamp): Promise<DateStr> {
  const today = now.slice(0, 10);
  for (const date of [addDays(today, -1), today]) {
    const shifts = await getShifts(userId, date);
    if (shifts.length === 0) continue;
    const rule = await effectiveShiftRule(userId, date);
    const window = clockOnWindow(shifts, rule.clockOnLeadMinutes);
    if (window && now >= window.earliest && now <= window.latest) return date;
  }
  return today;
}

function lastPunch(userId: number) {
  return db.get<{ at: Stamp; type: string; activity: string | null }>(
    'SELECT at, type, activity FROM punches WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT 1',
    [userId],
  );
}

export async function getClockState(userId: number, now: Stamp = nowStamp()): Promise<ClockState> {
  const user = await getUser(userId);
  const payrollDate = await currentPayrollDate(userId, now);
  const [shifts, rule] = await Promise.all([
    getShifts(userId, payrollDate),
    effectiveShiftRule(userId, payrollDate),
  ]);
  const window = clockOnWindow(shifts, rule.clockOnLeadMinutes);
  const segments = shifts.flatMap((s) => toSegments(s));

  const last = await lastPunch(userId);
  const clockedOn = !!last && last.type !== 'OFF';
  const activity = clockedOn ? last!.activity : null;
  const activityMeta = activity ? ACTIVITY_MAP.get(activity) : null;

  // Meal lock: once on an unpaid meal, the full duration must pass.
  let mealLockUntil: Stamp | null = null;
  if (clockedOn && activity === '99-001' && last) {
    const unlock = addMinutesTo(last.at, rule.lunchMinutes);
    if (unlock > now) mealLockUntil = unlock;
  }

  const inWindow = !!window && now >= window.earliest && now <= window.latest;
  const canClockOn = !clockedOn && inWindow;

  let message: string;
  if (clockedOn) {
    message = mealLockUntil
      ? `On ${activityMeta?.name ?? activity}. You can return to a productive activity at ${mealLockUntil.slice(11)}.`
      : `Clocked on to ${activityMeta?.name ?? activity} since ${last!.at.slice(11)}.`;
  } else if (!window) {
    message = 'You have no shift scheduled. You cannot clock on without a schedule.';
  } else if (now < window.earliest) {
    message = `Your shift window opens at ${window.earliest.slice(11)}. You cannot clock on before then.`;
  } else if (now > window.latest) {
    message = 'Your scheduled window has closed. Speak to your Team Leader if you need to record more time.';
  } else {
    message = 'Ready to clock on.';
  }

  const punchesToday = await db.all<{ at: Stamp; type: string; activity: string | null }>(
    'SELECT at, type, activity FROM punches WHERE user_id = ? AND at >= ? ORDER BY at',
    [userId, `${payrollDate} 00:00`],
  );

  const todaySegments = punchesToday
    .filter((p) => p.type !== 'OFF')
    .map((p, i, arr) => {
      const nextPunch = punchesToday.find((q) => q.at > p.at);
      return {
        activity: p.activity ?? '',
        name: ACTIVITY_MAP.get(p.activity ?? '')?.name ?? p.activity ?? '',
        startAt: p.at,
        endAt: nextPunch?.at ?? null,
      };
    });

  const availableActivities = await availableFor(user?.project_id ?? null);

  return {
    clockedOn,
    since: clockedOn ? last!.at : null,
    activity,
    activityName: activityMeta?.name ?? null,
    payrollDate,
    scheduledStart: segments[0]?.startAt ?? null,
    scheduledEnd: segments[segments.length - 1]?.endAt ?? null,
    canClockOn,
    message,
    mealLockUntil,
    todaySegments,
    availableActivities,
  };
}

/**
 * Activities an advisor may clock to. An employee whose project has no
 * configured activities sees an empty list — which is the visible symptom of a
 * profile that has not been set up correctly, so we say so rather than showing
 * an unexplained blank dropdown.
 */
export async function availableFor(projectId: string | null) {
  if (!projectId) return [];
  const rows = await db.all<{ activity_code: string }>(
    'SELECT activity_code FROM project_activities WHERE activity_id = ?',
    [projectId],
  );
  return rows
    .map((r) => ACTIVITY_MAP.get(r.activity_code))
    .filter((a): a is NonNullable<typeof a> => !!a)
    .map((a) => ({ code: a.code, name: a.name, family: a.family }));
}

export interface PunchResult {
  ok: boolean;
  message: string;
  state: ClockState;
}

export async function punch(params: {
  userId: number;
  type: 'ON' | 'OFF' | 'CHANGE';
  activity?: string | null;
  actorId: number;
  now?: Stamp;
}): Promise<PunchResult> {
  const { userId, type, actorId } = params;
  const now = params.now ?? nowStamp();
  const state = await getClockState(userId, now);
  const rule = await effectiveShiftRule(userId, state.payrollDate ?? todayStr());

  const fail = (message: string): PunchResult => ({ ok: false, message, state });

  if (type === 'ON') {
    if (state.clockedOn) return fail('You are already clocked on.');
    if (!state.canClockOn) return fail(state.message);
    if (!params.activity) return fail('Choose an activity to clock on to.');
  }

  if (type === 'CHANGE') {
    if (!state.clockedOn) return fail('Clock on before changing activity.');
    if (!params.activity) return fail('Choose an activity.');
    if (state.mealLockUntil) {
      const target = ACTIVITY_MAP.get(params.activity);
      if (target?.paid) {
        return fail(
          `Your meal period runs until ${state.mealLockUntil.slice(11)}. You cannot return to a paid activity before then.`,
        );
      }
    }
    if (params.activity === state.activity) return fail('You are already on that activity.');
  }

  if (type === 'OFF' && !state.clockedOn) return fail('You are not clocked on.');

  if (params.activity && !ACTIVITY_MAP.has(params.activity)) {
    return fail('That activity code is not recognised.');
  }

  const user = await getUser(userId);
  if (params.activity && user?.project_id) {
    const allowed = (await availableFor(user.project_id)).some((a) => a.code === params.activity);
    if (!allowed) {
      return fail(
        'That activity is not configured for your project. If your activity list looks wrong, your project or department code needs correcting.',
      );
    }
  }

  await db.run('INSERT INTO punches (user_id, at, type, activity, source) VALUES (?, ?, ?, ?, ?)', [
    userId,
    now,
    type,
    type === 'OFF' ? null : (params.activity ?? null),
    'WEB_CLOCK',
  ]);
  await audit(actorId, 'punch', userId, type, { at: now, activity: params.activity ?? null });

  // Keep the card in step with the punch stream so a supervisor watching the
  // payroll summary sees the shift build up live.
  const payrollDate = state.payrollDate ?? todayStr();
  await generateTimecard({ userId, date: payrollDate, actorId, now });

  const after = await getClockState(userId, now);
  const verb =
    type === 'ON'
      ? `Clocked on at ${now.slice(11)}.`
      : type === 'OFF'
        ? `Clocked off at ${now.slice(11)}.`
        : `Changed to ${ACTIVITY_MAP.get(params.activity!)?.name} at ${now.slice(11)}.`;

  // Flag lateness at the moment it happens rather than the next morning.
  let note = '';
  let lateMinutes = 0;
  if (type === 'ON' && after.scheduledStart) {
    const late = diffMinutes(after.scheduledStart, now);
    if (late > rule.lateGraceMinutes) {
      lateMinutes = late;
      note = ` You are ${late} minutes late; a Late exception has been raised.`;
    }
  }

  // Push the punch to anyone watching the live board, so the intraday picture
  // is right the moment it changes rather than at the next poll.
  emit('punch', userId, `${user?.name ?? 'Someone'} ${verb.toLowerCase().replace(/\.$/, '')}`, {
    type,
    activity: params.activity ?? null,
    payrollDate,
    lateMinutes,
  });

  // Lateness is the one punch worth interrupting a supervisor for: it is still
  // fixable while the shift is running and useless information the next day.
  if (lateMinutes > 0) {
    await notify(
      await supervisorsOf(userId),
      'Late start',
      `${user?.name ?? `#${userId}`} clocked on ${lateMinutes} minutes late at ${now.slice(11)}.`,
      'WARN',
    );
  }

  return { ok: true, message: verb + note, state: after };
}

function addMinutesTo(s: Stamp, mins: number): Stamp {
  const d = new Date(`${s.replace(' ', 'T')}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + mins);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
