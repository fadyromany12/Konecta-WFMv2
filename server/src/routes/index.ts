import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { audit, db } from '../db/index.js';
import { authenticate, requireRole, requireSupervisor, signToken } from '../middleware/auth.js';
import { asyncRoute, HttpError } from '../middleware/errors.js';
import {
  ACTIVITIES,
  EDIT_WINDOW_DAYS,
  MANUAL_CHECK_STATUSES,
  PRODUCT,
  ROLES,
  ROLE_LABELS,
  SCHEDULE_ACTIVITIES,
  SHIFT_RULES,
  TIMECARD_CODES,
  type Role,
} from '../domain/reference.js';
import { EMPLOYMENT_STATUSES, STATUS_LABELS, assignableRoles, effectiveStatus } from '../domain/org.js';
import {
  changeOwnPassword,
  createPerson,
  recordLeaver,
  reinstate,
  resetPassword,
  setStatus,
  signIn,
  updatePerson,
} from '../services/directory.js';
import { buildAdherenceReport, punctuality } from '../domain/adherence.js';
import { evaluateEdit } from '../domain/editWindow.js';
import { assessApproval, assessRequest } from '../domain/leaveBalance.js';
import { addDays, diffMinutes, nowStamp, todayStr } from '../domain/time.js';
import {
  canManage,
  effectiveShiftRule,
  getUser,
  getUserByEmail,
  listGroups,
  pendingShiftRuleChanges,
  placeholders,
  resolveGroup,
  visibleUserIds,
} from '../services/people.js';
import { getClockState, punch } from '../services/clock.js';
import { weekCover } from '../services/planning.js';
import { historyFor, rulesLog } from '../services/history.js';
import { emit, notify } from '../services/events.js';
import {
  applyGroupException,
  getShifts,
  getShiftsInRange,
  moveShift,
  publishSchedules,
  removeGroupException,
  saveShifts,
  teamWeek,
} from '../services/scheduling.js';
import { costTimecard, dayCharacter, type HolidayElection } from '../domain/pay.js';
import {
  holidayDates,
  listHolidays,
  settleHoliday,
  upcomingHolidays,
} from '../services/holidays.js';
import {
  EGYPT_RATES,
  actualCost,
  electHolidaySettlement,
  nightAllowanceFor,
  plannedCost,
  ramadanFor,
  summariseCost,
} from '../services/pay.js';
import {
  generateTimecard,
  payrollSummary,
  runPayroll,
  saveTimecard,
  setApproval,
  setManualCheck,
  viewTimecard,
} from '../services/timecards.js';

export const api = Router();

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date');
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Times use a 24 hour clock, e.g. 05:00');
const stampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/);

// ------------------------------------------------------------------ auth
api.post(
  '/auth/login',
  asyncRoute(async (req, res) => {
    const body = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const outcome = await signIn(body.email, body.password);
    if (!outcome.ok || !outcome.user) {
      throw new HttpError(outcome.status ?? 401, outcome.message ?? 'Sign in failed.');
    }
    res.json({ token: signToken(outcome.user.id), user: shapeUser(outcome.user) });
  }),
);

api.get('/auth/me', authenticate, (req, res) => {
  res.json({ user: shapeUser(req.user!) });
});

api.post(
  '/auth/password',
  authenticate,
  asyncRoute(async (req, res) => {
    const body = z
      .object({ currentPassword: z.string(), newPassword: z.string() })
      .parse(req.body);
    await changeOwnPassword(req.user!.id, body.currentPassword, body.newPassword);
    res.json({ ok: true, message: 'Password changed.' });
  }),
);

function shapeUser(u: any) {
  return {
    id: u.id,
    employeeId: u.employee_id,
    name: u.name,
    email: u.email,
    role: u.role,
    roleLabel: ROLE_LABELS[u.role as keyof typeof ROLE_LABELS],
    projectId: u.project_id,
    departmentCode: u.department_code,
    region: u.region,
    shiftRule: u.shift_rule,
    status: u.status,
    leaveDate: u.leave_date ?? null,
    editWindowDays: EDIT_WINDOW_DAYS[u.role as keyof typeof EDIT_WINDOW_DAYS],
    isSupervisor: u.role !== 'ADVISOR',
    mustChangePassword: !!u.must_change_password,
    canAdminister: assignableRoles(u.role as Role),
  };
}

// --------------------------------------------------------------- catalogue
api.get('/catalog', authenticate, (_req, res) => {
  res.json({
    product: PRODUCT,
    activities: ACTIVITIES,
    codes: TIMECARD_CODES,
    scheduleActivities: SCHEDULE_ACTIVITIES,
    shiftRules: SHIFT_RULES,
    manualCheckStatuses: MANUAL_CHECK_STATUSES,
    editWindows: EDIT_WINDOW_DAYS,
    roleLabels: ROLE_LABELS,
    roles: ROLES,
    employmentStatuses: EMPLOYMENT_STATUSES,
    statusLabels: STATUS_LABELS,
    today: todayStr(),
  });
});

// ------------------------------------------------------------------ people
api.get(
  '/people/groups',
  authenticate,
  asyncRoute(async (req, res) => {
    res.json({ groups: await listGroups(req.user!) });
  }),
);

api.get(
  '/people',
  authenticate,
  asyncRoute(async (req, res) => {
    const group = typeof req.query.group === 'string' ? req.query.group : undefined;
    const ids = await resolveGroup(req.user!, group);
    if (ids.length === 0) {
      res.json({ people: [] });
      return;
    }
    const rows = await db.all<any>(
      `SELECT u.id, u.employee_id, u.name, u.email, u.role, u.project_id, u.department_code, u.status,
              u.shift_rule, u.leave_date, u.manager_id, u.must_change_password, m.name AS manager_name
       FROM users u LEFT JOIN users m ON m.id = u.manager_id
       WHERE u.id IN (${placeholders(ids.length)}) ORDER BY u.name`,
      ids,
    );
    // The stored status and today's status differ for anyone inside a notice
    // period, and a directory that shows the stored one would list a leaver as
    // Active on the day after they left.
    const today = todayStr();
    const people = rows.map((row) => ({
      ...row,
      effective_status: effectiveStatus(row, today),
      leaving: !!row.leave_date && row.leave_date >= today,
    }));
    res.json({ people });
  }),
);

api.get(
  '/people/:id',
  authenticate,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await canManage(req.user!, id))) throw new HttpError(403, 'You cannot view that employee.');
    const user = await getUser(id);
    if (!user) throw new HttpError(404, 'No such employee.');
    const today = todayStr();
    const [project, shiftRule, shiftRuleHistory, accruals] = await Promise.all([
      user.project_id
        ? db.get('SELECT * FROM projects WHERE activity_id = ?', [user.project_id])
        : Promise.resolve(null),
      effectiveShiftRule(id, today),
      pendingShiftRuleChanges(id, today),
      db.all('SELECT accrual_type, balance_hours, as_of FROM accruals WHERE user_id = ? ORDER BY accrual_type', [id]),
    ]);
    res.json({ person: shapeUser(user), project, shiftRule, shiftRuleHistory, accruals });
  }),
);

// ------------------------------------------------- joiners, movers, leavers
//
// Everything below changes an employment record. `DirectoryError` carries the
// status and the list of problems, so the handlers stay this thin and the
// wording lives with the rule it belongs to.

const roleSchema = z.enum(ROLES);

api.post(
  '/people',
  authenticate,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        employeeId: z.string(),
        name: z.string(),
        email: z.string(),
        role: roleSchema,
        managerId: z.number().int().nullable().default(null),
        projectId: z.string().nullable().default(null),
        departmentCode: z.string().default('10000'),
        shiftRule: z.string().default('CR1'),
        hireDate: dateSchema.nullable().default(null),
        region: z.string().default('EMEA'),
      })
      .parse(req.body);
    res.status(201).json(await createPerson(req.user!, body));
  }),
);

api.patch(
  '/people/:id',
  authenticate,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        name: z.string().optional(),
        email: z.string().optional(),
        role: roleSchema.optional(),
        managerId: z.number().int().nullable().optional(),
        projectId: z.string().nullable().optional(),
        departmentCode: z.string().optional(),
        shiftRule: z.string().optional(),
        region: z.string().optional(),
        hireDate: dateSchema.nullable().optional(),
      })
      .parse(req.body);
    res.json(await updatePerson(req.user!, Number(req.params.id), body));
  }),
);

api.post(
  '/people/:id/leave',
  authenticate,
  asyncRoute(async (req, res) => {
    const body = z.object({ leaveDate: dateSchema }).parse(req.body);
    const out = await recordLeaver(req.user!, Number(req.params.id), body.leaveDate);
    res.json({
      ...out,
      message: `Access ends after ${body.leaveDate}. They keep working until the end of that day.`,
    });
  }),
);

api.post(
  '/people/:id/status',
  authenticate,
  asyncRoute(async (req, res) => {
    const body = z.object({ status: z.enum(EMPLOYMENT_STATUSES) }).parse(req.body);
    await setStatus(req.user!, Number(req.params.id), body.status);
    res.json({ ok: true });
  }),
);

api.post(
  '/people/:id/reinstate',
  authenticate,
  asyncRoute(async (req, res) => {
    await reinstate(req.user!, Number(req.params.id));
    res.json({ ok: true, message: 'Reinstated, with any lockout cleared.' });
  }),
);

api.post(
  '/people/:id/reset-password',
  authenticate,
  asyncRoute(async (req, res) => {
    const password = await resetPassword(req.user!, Number(req.params.id));
    res.json({
      temporaryPassword: password,
      message: 'Hand this over in person. It cannot be retrieved again, and it must be changed at sign-in.',
    });
  }),
);

// ------------------------------------------------------------------- clock
api.get(
  '/clock',
  authenticate,
  asyncRoute(async (req, res) => {
    res.json(await getClockState(req.user!.id));
  }),
);

api.post(
  '/clock/punch',
  authenticate,
  asyncRoute(async (req, res) => {
    const body = z
      .object({ type: z.enum(['ON', 'OFF', 'CHANGE']), activity: z.string().nullish() })
      .parse(req.body);
    const result = await punch({
      userId: req.user!.id,
      type: body.type,
      activity: body.activity ?? null,
      actorId: req.user!.id,
    });
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

// ----------------------------------------------------------------- history
api.get(
  '/history/:userId',
  authenticate,
  asyncRoute(async (req, res) => {
    const userId = Number(req.params.userId);
    // An advisor may read their own, and a supervisor may read anyone they
    // manage. Nobody reads a peer's — this is a record of things done to a
    // person, not a public log.
    const own = req.user!.id === userId;
    if (!own && !(await canManage(req.user!, userId))) {
      throw new HttpError(403, 'You cannot view that history.');
    }
    const end = dateSchema.parse(req.query.end ?? addDays(todayStr(), 14));
    const start = dateSchema.parse(req.query.start ?? addDays(end, -45));
    res.json({ entries: await historyFor({ userId, start, end }) });
  }),
);

// --------------------------------------------------------------- schedules
// Registered before `/schedules/:userId`, or Express reads "team" as a user id.
api.get(
  '/schedules/team',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const start = dateSchema.parse(req.query.start ?? todayStr());
    const end = dateSchema.parse(req.query.end ?? addDays(start, 6));
    if (end < start) throw new HttpError(400, 'The end of the range is before the start.');
    if (diffMinutes(`${start} 00:00`, `${end} 00:00`) > 31 * 24 * 60) {
      throw new HttpError(400, 'Ask for a month at a time or less.');
    }
    const userIds = await resolveGroup(req.user!, req.query.group as string | undefined);
    const week = await teamWeek({ userIds, start, end });

    // Cover is best-effort here. A team leader without a project on their
    // account still needs the grid; they simply do not get the requirement
    // line under each date, and a missing forecast is not a reason to fail the
    // whole screen.
    const projectId =
      (typeof req.query.project === 'string' ? req.query.project : null) ?? req.user!.project_id;
    const cover = projectId
      ? await weekCover({ projectId, userIds, dates: week.dates })
      : [];

    res.json({ ...week, cover });
  }),
);

api.post(
  '/schedules/publish',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const body = z
      .object({ group: z.string().optional(), start: dateSchema, end: dateSchema })
      .parse(req.body);
    if (body.end < body.start) throw new HttpError(400, 'The end of the range is before the start.');

    const userIds = await resolveGroup(req.user!, body.group);
    const result = await publishSchedules({
      userIds,
      start: body.start,
      end: body.end,
      actorId: req.user!.id,
    });

    // One message per person naming their own days, not a broadcast. "The
    // schedule is published" tells an advisor nothing they can act on; "you
    // are working Tue, Thu, Sat" does.
    for (const person of result.affected) {
      emit('schedule.changed', person.userId, `${req.user!.name} published your schedule`, {
        date: person.dates[0],
      });
      await notify(
        [person.userId],
        'Your schedule is published',
        `${req.user!.name} published ${person.dates.length} day${person.dates.length === 1 ? '' : 's'}: ` +
          `${person.dates.join(', ')}. It is on My Week now.`,
      );
    }
    res.json(result);
  }),
);

api.post(
  '/schedules/move',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        userId: z.number().int().positive(),
        fromDate: dateSchema,
        toDate: dateSchema,
        shiftNo: z.number().int().positive(),
      })
      .parse(req.body);
    if (!(await canManage(req.user!, body.userId))) throw new HttpError(403, 'You cannot edit that schedule.');

    const result = await moveShift({ ...body, today: todayStr(), actorId: req.user!.id });
    if (result.ok) {
      // Both days change shape, so both cards have to be re-derived.
      for (const date of [body.fromDate, body.toDate]) {
        await generateTimecard({ userId: body.userId, date, actorId: req.user!.id });
      }
      const who = (await getUser(body.userId))?.name ?? `#${body.userId}`;
      emit('schedule.changed', body.userId, `${req.user!.name} moved ${who}'s shift to ${body.toDate}`, {
        date: body.toDate,
      });
      await notify(
        [body.userId],
        'Your shift moved',
        `${req.user!.name} moved your ${body.fromDate} shift to ${body.toDate}. Check My Week.`,
      );
    }
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

api.get(
  '/schedules/:userId',
  authenticate,
  asyncRoute(async (req, res) => {
    const userId = Number(req.params.userId);
    if (!(await canManage(req.user!, userId))) throw new HttpError(403, 'You cannot view that schedule.');
    const start = dateSchema.parse(req.query.start ?? todayStr());
    const end = dateSchema.parse(req.query.end ?? start);
    // One endpoint, two audiences: the editor a supervisor builds a week in,
    // and the week an advisor reads. A supervisor sees their own drafts; the
    // advisor whose week it is sees only what they have actually been told,
    // even when they are the one asking.
    const includeDrafts = req.user!.role !== 'ADVISOR' && req.user!.id !== userId;
    res.json({ days: await getShiftsInRange(userId, start, end, { includeDrafts }) });
  }),
);

const shiftSchema = z.object({
  shiftNo: z.number().int().positive(),
  endAt: stampSchema,
  rows: z
    .array(z.object({ startAt: stampSchema, activityKey: z.string() }))
    .min(1, 'A shift needs at least one row.'),
});

api.put(
  '/schedules/:userId/:date',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const userId = Number(req.params.userId);
    const date = dateSchema.parse(req.params.date);
    if (!(await canManage(req.user!, userId))) throw new HttpError(403, 'You cannot edit that schedule.');
    const body = z.object({ shifts: z.array(shiftSchema) }).parse(req.body);
    const result = await saveShifts({
      userId,
      date,
      shifts: body.shifts as any,
      actorId: req.user!.id,
    });
    // Re-derive the card so schedule-driven exceptions follow the new plan.
    if (result.ok) {
      await generateTimecard({ userId, date, actorId: req.user!.id });
      const who = (await getUser(userId))?.name ?? `#${userId}`;
      emit('schedule.changed', userId, `${req.user!.name} changed ${who}'s ${date} schedule`, { date });
      await notify(
        [userId],
        'Your schedule changed',
        `${req.user!.name} edited your schedule for ${date}. Check My Shifts before you next work.`,
      );
    }
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

api.post(
  '/schedules/group-exception',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        group: z.string().optional(),
        userIds: z.array(z.number()).optional(),
        date: dateSchema,
        activityKey: z.string(),
        startTime: timeSchema,
        endTime: timeSchema,
      })
      .parse(req.body);

    const ids = body.userIds ?? (await resolveGroup(req.user!, body.group));
    const allowed = new Set(await visibleUserIds(req.user!));
    const targets = ids.filter((id) => allowed.has(id));
    if (targets.length === 0) throw new HttpError(400, 'No employees in range for that group.');

    const result = await applyGroupException({
      userIds: targets,
      date: body.date,
      activityKey: body.activityKey as any,
      startTime: body.startTime,
      endTime: body.endTime,
      actorId: req.user!.id,
    });
    const activityName =
      SCHEDULE_ACTIVITIES.find((a) => a.key === body.activityKey)?.name ?? body.activityKey;
    for (const userId of result.applied) {
      await generateTimecard({ userId, date: body.date, actorId: req.user!.id });
      emit('schedule.changed', userId, `${activityName} added to ${body.date}`, { date: body.date });
    }
    await notify(
      result.applied,
      'Schedule exception added',
      `${activityName} on ${body.date}, ${body.startTime}–${body.endTime}, added by ${req.user!.name}.`,
    );
    res.json(result);
  }),
);

api.post(
  '/schedules/group-exception/remove',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        group: z.string().optional(),
        userIds: z.array(z.number()).optional(),
        date: dateSchema,
        activityKey: z.string(),
        startTime: timeSchema,
        endTime: timeSchema,
      })
      .parse(req.body);

    const ids = body.userIds ?? (await resolveGroup(req.user!, body.group));
    const allowed = new Set(await visibleUserIds(req.user!));
    const targets = ids.filter((id) => allowed.has(id));
    if (targets.length === 0) throw new HttpError(400, 'No employees in range for that group.');

    const result = await removeGroupException({
      userIds: targets,
      date: body.date,
      activityKey: body.activityKey as any,
      startTime: body.startTime,
      endTime: body.endTime,
      actorId: req.user!.id,
    });
    for (const userId of result.removed) {
      await generateTimecard({ userId, date: body.date, actorId: req.user!.id });
      emit('schedule.changed', userId, `An exception was removed from ${body.date}`, { date: body.date });
    }
    res.json(result);
  }),
);

// --------------------------------------------------------------- timecards
api.get(
  '/timecards/:userId/:date',
  authenticate,
  asyncRoute(async (req, res) => {
    const userId = Number(req.params.userId);
    const date = dateSchema.parse(req.params.date);
    if (!(await canManage(req.user!, userId))) throw new HttpError(403, 'You cannot view that timecard.');

    const view = await viewTimecard({ userId, date, actorId: req.user!.id });
    const decision = evaluateEdit({
      role: req.user!.role,
      payrollDate: date,
      today: todayStr(),
      protectDate: view?.protectDate ?? null,
    });
    const shifts = await getShifts(userId, date, { includeDrafts: true });
    const holidays = await holidayDates(date, date);
    const character = dayCharacter({ date, holidays, scheduled: shifts.length > 0 });
    res.json({
      timecard: view,
      decision,
      shifts,
      // The cost travels with the card because the settlement decision is taken
      // here, reading this card, and a supervisor choosing between triple time
      // and a banked day needs to see what each one comes to.
      pay: view
        ? costTimecard({
            rows: view.rows,
            dayCharacter: character,
            election: view.holidayElection as HolidayElection | null,
          })
        : null,
      holiday: (await listHolidays(date, date))[0] ?? null,
    });
  }),
);

const rowSchema = z.object({
  code: z.string(),
  project: z.string(),
  activity: z.string(),
  startAt: stampSchema,
  endAt: stampSchema,
});

api.put(
  '/timecards/:userId/:date',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const userId = Number(req.params.userId);
    const date = dateSchema.parse(req.params.date);
    if (!(await canManage(req.user!, userId))) throw new HttpError(403, 'You cannot edit that timecard.');
    const body = z
      .object({ rows: z.array(rowSchema), correctionReason: z.string().max(500).optional() })
      .parse(req.body);
    const result = await saveTimecard({
      correctionReason: body.correctionReason,
      userId,
      date,
      rows: body.rows,
      actorId: req.user!.id,
      actorRole: req.user!.role,
    });
    if (result.ok) {
      const who = (await getUser(userId))?.name ?? `#${userId}`;
      emit('timecard.saved', userId, `${req.user!.name} edited ${who}'s ${date} timecard`, {
        payrollDate: date,
      });
    }
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

api.post(
  '/timecards/:userId/:date/approve',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const userId = Number(req.params.userId);
    const date = dateSchema.parse(req.params.date);
    if (!(await canManage(req.user!, userId))) throw new HttpError(403, 'You cannot approve that timecard.');
    const body = z.object({ approved: z.boolean() }).parse(req.body);
    const result = await setApproval({
      userId,
      date,
      approved: body.approved,
      actorId: req.user!.id,
      actorRole: req.user!.role,
    });
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

api.post(
  '/timecards/:userId/:date/rebuild',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const userId = Number(req.params.userId);
    const date = dateSchema.parse(req.params.date);
    if (!(await canManage(req.user!, userId))) throw new HttpError(403, 'You cannot rebuild that timecard.');
    await generateTimecard({ userId, date, actorId: req.user!.id, force: true });
    res.json({ ok: true, timecard: await viewTimecard({ userId, date, autoGenerate: false }) });
  }),
);

api.post(
  '/timecards/:userId/:date/manual-check',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const userId = Number(req.params.userId);
    const date = dateSchema.parse(req.params.date);
    if (!(await canManage(req.user!, userId))) throw new HttpError(403, 'You cannot change that timecard.');
    const body = z.object({ status: z.enum(MANUAL_CHECK_STATUSES) }).parse(req.body);
    const result = await setManualCheck({ userId, date, status: body.status, actorId: req.user!.id });
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

// ----------------------------------------------------------------- payroll
api.get(
  '/payroll/summary',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const start = dateSchema.parse(req.query.start ?? todayStr());
    const end = dateSchema.parse(req.query.end ?? start);
    const group = typeof req.query.group === 'string' ? req.query.group : undefined;
    const ids = await resolveGroup(req.user!, group);
    res.json({
      rows: await payrollSummary({ userIds: ids, start, end, actorId: req.user!.id }),
      editWindowDays: EDIT_WINDOW_DAYS[req.user!.role],
    });
  }),
);

// -------------------------------------------------------------------- pay
//
// Cost is expressed in hours at the base rate throughout. No salary is held in
// this system, and a paid-hours figure multiplies into money whenever somebody
// who has the rates needs it to.

api.get(
  '/pay/rates',
  authenticate,
  asyncRoute(async (_req, res) => {
    res.json({
      rates: EGYPT_RATES,
      basis:
        'Overtime rates and the night window are Egyptian Labour Law No. 14 of 2025. ' +
        'Rest day, public holiday and the day in lieu are Konecta policy. ' +
        'Premiums do not stack: the character of the day sets the rate for every hour worked in it.',
    });
  }),
);

/** How much of the monthly night allowance somebody earned. */
api.get(
  '/pay/night-allowance/:userId',
  authenticate,
  asyncRoute(async (req, res) => {
    const userId = Number(req.params.userId);
    if (userId !== req.user!.id && !(await canManage(req.user!, userId))) {
      throw new HttpError(403, 'You cannot see that.');
    }
    const month = z
      .string()
      .regex(/^\d{4}-\d{2}$/, 'Expected a YYYY-MM month')
      .parse(req.query.month ?? todayStr().slice(0, 7));
    res.json(await nightAllowanceFor({ userId, month, actorId: req.user!.id }));
  }),
);

/** The dates Egypt keeps a six hour working day, which is when overtime starts. */
api.get(
  '/pay/ramadan',
  authenticate,
  asyncRoute(async (req, res) => {
    const start = dateSchema.parse(req.query.start ?? todayStr());
    const end = dateSchema.parse(req.query.end ?? addDays(start, 365));
    res.json({ dates: [...(await ramadanFor(start, end))].sort(), normHours: EGYPT_RATES.ramadanNormHours });
  }),
);

api.get(
  '/pay/holidays',
  authenticate,
  asyncRoute(async (req, res) => {
    const start = dateSchema.parse(req.query.start ?? todayStr());
    const end = dateSchema.parse(req.query.end ?? addDays(start, 365));
    res.json({ holidays: await listHolidays(start, end) });
  }),
);

api.get(
  '/pay/holidays/upcoming',
  authenticate,
  asyncRoute(async (req, res) => {
    const days = Math.min(400, Math.max(1, Number(req.query.days ?? 90)));
    res.json({ holidays: await upcomingHolidays(days) });
  }),
);

/**
 * Confirm an estimated holiday, or move it to the date that was announced.
 *
 * Restricted above supervisor: moving a public holiday changes what a whole
 * region is paid for a day, which is not a team-level decision.
 */
api.post(
  '/pay/holidays/:date/settle',
  authenticate,
  requireRole('OPS_MANAGER', 'ADMIN'),
  asyncRoute(async (req, res) => {
    const date = dateSchema.parse(req.params.date);
    const body = z
      .object({ actualDate: dateSchema.optional(), name: z.string().min(1).max(120).optional() })
      .parse(req.body ?? {});
    const result = await settleHoliday({ date, ...body, actorId: req.user!.id });
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

/** What a stretch of somebody's worked time cost. */
api.get(
  '/pay/cost/:userId',
  authenticate,
  asyncRoute(async (req, res) => {
    const userId = Number(req.params.userId);
    if (userId !== req.user!.id && !(await canManage(req.user!, userId))) {
      throw new HttpError(403, 'You cannot see that.');
    }
    const start = dateSchema.parse(req.query.start ?? todayStr());
    const end = dateSchema.parse(req.query.end ?? start);
    const days = await actualCost({ userId, start, end, actorId: req.user!.id });
    res.json({ days, total: summariseCost(days) });
  }),
);

/** What a roster commits to, while there is still time to change it. */
api.get(
  '/pay/roster',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const start = dateSchema.parse(req.query.start ?? todayStr());
    const end = dateSchema.parse(req.query.end ?? addDays(start, 6));
    const group = typeof req.query.group === 'string' ? req.query.group : undefined;
    const ids = await resolveGroup(req.user!, group);
    const days = await plannedCost({
      userIds: ids,
      start,
      end,
      includeDrafts: req.query.drafts === 'true',
    });
    res.json({ days, total: summariseCost(days) });
  }),
);

/**
 * Settle a worked public holiday. The supervisor's decision, taken at approval.
 */
api.post(
  '/pay/timecards/:id/holiday-election',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const body = z.object({ election: z.enum(['PAY_3X', 'PAY_2X_PLUS_DAY']) }).parse(req.body);
    const owner = await db.get<{ user_id: number }>('SELECT user_id FROM timecards WHERE id = ?', [id]);
    if (!owner) throw new HttpError(404, 'No such timecard.');
    if (!(await canManage(req.user!, owner.user_id))) {
      throw new HttpError(403, 'You cannot settle that timecard.');
    }
    const result = await electHolidaySettlement({
      timecardId: id,
      election: body.election,
      actorId: req.user!.id,
    });
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

api.get(
  '/payroll/periods',
  authenticate,
  asyncRoute(async (req, res) => {
    res.json({
      periods: await db.all('SELECT * FROM payroll_periods WHERE region = ? ORDER BY start_date DESC', [
        req.user!.region,
      ]),
    });
  }),
);

api.post(
  '/payroll/run',
  authenticate,
  requireRole('OPS_MANAGER', 'ADMIN'),
  asyncRoute(async (req, res) => {
    const body = z.object({ start: dateSchema, end: dateSchema }).parse(req.body);
    const result = await runPayroll({
      region: req.user!.region,
      start: body.start,
      end: body.end,
      actorId: req.user!.id,
    });
    res.json({
      ok: true,
      ...result,
      message: `Payroll run. ${result.protectedCards} timecards are now protected; later edits become post-payroll corrections.`,
    });
  }),
);

// ----------------------------------------------------------------- absence
api.get(
  '/absence/accruals',
  authenticate,
  asyncRoute(async (req, res) => {
    const userId = req.query.userId ? Number(req.query.userId) : req.user!.id;
    if (!(await canManage(req.user!, userId))) throw new HttpError(403, 'You cannot view those balances.');
    res.json({
      accruals: await db.all('SELECT accrual_type, balance_hours, as_of FROM accruals WHERE user_id = ? ORDER BY accrual_type', [
        userId,
      ]),
    });
  }),
);

api.get(
  '/absence/requests',
  authenticate,
  asyncRoute(async (req, res) => {
    const ids = req.user!.role === 'ADVISOR' ? [req.user!.id] : await visibleUserIds(req.user!);
    res.json({
      requests: await db.all(
        `SELECT r.*, u.name AS user_name, u.employee_id
         FROM time_off_requests r JOIN users u ON u.id = r.user_id
         WHERE r.user_id IN (${placeholders(ids.length)})
         ORDER BY r.start_date DESC LIMIT 200`,
        ids,
      ),
    });
  }),
);

api.post(
  '/absence/requests',
  authenticate,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        accrualType: z.enum(['VACATION', 'SICK', 'UNPAID']),
        startDate: dateSchema,
        endDate: dateSchema,
        hours: z.number().positive(),
        reason: z.string().max(500).optional(),
      })
      .parse(req.body);

    // Judged against the balance *and* everything already on file. Checking
    // only the balance is correct exactly once: ask twice and both pass,
    // because neither request knows about the other.
    const [balance, claims] = await Promise.all([
      db.get<{ balance_hours: number }>(
        'SELECT balance_hours FROM accruals WHERE user_id = ? AND accrual_type = ?',
        [req.user!.id, body.accrualType],
      ),
      db.all<{ start_date: string; end_date: string; accrual_type: string; hours: number; status: string }>(
        `SELECT start_date, end_date, accrual_type, hours, status FROM time_off_requests
         WHERE user_id = ? AND status IN ('PENDING', 'APPROVED')`,
        [req.user!.id],
      ),
    ]);

    const verdict = assessRequest({
      accrualType: body.accrualType,
      startDate: body.startDate,
      endDate: body.endDate,
      hours: body.hours,
      balanceHours: balance?.balance_hours ?? 0,
      claims: claims.map((c) => ({
        startDate: c.start_date as any,
        endDate: c.end_date as any,
        accrualType: c.accrual_type,
        hours: c.hours,
        status: c.status,
      })),
    });
    if (!verdict.ok) throw new HttpError(400, verdict.reason!);

    const id = await db.insert(
      `INSERT INTO time_off_requests (user_id, accrual_type, start_date, end_date, hours, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.user!.id, body.accrualType, body.startDate, body.endDate, body.hours, body.reason ?? null],
    );
    res.json({ ok: true, id });
  }),
);

api.post(
  '/absence/requests/:id/decision',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const body = z.object({ status: z.enum(['APPROVED', 'DECLINED']) }).parse(req.body);
    const request = await db.get<any>('SELECT * FROM time_off_requests WHERE id = ?', [id]);
    if (!request) throw new HttpError(404, 'No such request.');
    if (!(await canManage(req.user!, request.user_id))) {
      throw new HttpError(403, 'That request is not yours to decide.');
    }

    // Checked again here, not just when it was raised. The balance can have
    // moved since — another request approved, a correction, a new accrual year
    // — so approving on the strength of the original check trusts a number that
    // may no longer be true.
    if (body.status === 'APPROVED') {
      const balance = await db.get<{ balance_hours: number }>(
        'SELECT balance_hours FROM accruals WHERE user_id = ? AND accrual_type = ?',
        [request.user_id, request.accrual_type],
      );
      const verdict = assessApproval({
        accrualType: request.accrual_type,
        hours: request.hours,
        balanceHours: balance?.balance_hours ?? 0,
      });
      if (!verdict.ok) throw new HttpError(400, verdict.reason!);
    }

    await db.run('UPDATE time_off_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', [
      body.status,
      req.user!.id,
      nowStamp(),
      id,
    ]);

    if (body.status === 'APPROVED' && request.accrual_type !== 'UNPAID') {
      await db.run(
        'UPDATE accruals SET balance_hours = balance_hours - ? WHERE user_id = ? AND accrual_type = ?',
        [request.hours, request.user_id, request.accrual_type],
      );
    }

    await notify(
      [request.user_id],
      `Time off ${body.status.toLowerCase()}`,
      `${req.user!.name} ${body.status.toLowerCase()} your ${request.accrual_type.toLowerCase()} request for ` +
        `${request.start_date}${request.end_date === request.start_date ? '' : ` to ${request.end_date}`} (${request.hours}h).`,
      body.status === 'APPROVED' ? 'INFO' : 'WARN',
    );
    emit('message', request.user_id, `Time off ${body.status.toLowerCase()}`, { requestId: id });

    res.json({ ok: true });
  }),
);

// ------------------------------------------------------------------- home
api.get(
  '/messages',
  authenticate,
  asyncRoute(async (req, res) => {
    res.json({
      messages: await db.all('SELECT * FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 50', [
        req.user!.id,
      ]),
    });
  }),
);

api.post(
  '/messages/:id/read',
  authenticate,
  asyncRoute(async (req, res) => {
    await db.run('UPDATE messages SET read_flag = 1 WHERE id = ? AND user_id = ?', [
      Number(req.params.id),
      req.user!.id,
    ]);
    res.json({ ok: true });
  }),
);

// ------------------------------------------------------------------ reports
api.get(
  '/reports/adherence',
  authenticate,
  asyncRoute(async (req, res) => {
    const userId = Number(req.query.userId ?? req.user!.id);
    const date = dateSchema.parse(req.query.date ?? addDays(todayStr(), -1));
    if (!(await canManage(req.user!, userId))) throw new HttpError(403, 'You cannot view that report.');

    const [shifts, view, user] = await Promise.all([
      getShifts(userId, date),
      viewTimecard({ userId, date, actorId: req.user!.id }),
      getUser(userId),
    ]);
    const rows = view?.rows ?? [];
    res.json({
      user: shapeUser(user),
      date,
      report: buildAdherenceReport({ shifts, rows }),
      punctuality: punctuality(shifts, rows),
      timecard: view,
      shifts,
    });
  }),
);

/** Non-worked exception report: every exception code across a group and range. */
api.get(
  '/reports/exceptions',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const start = dateSchema.parse(req.query.start ?? addDays(todayStr(), -7));
    const end = dateSchema.parse(req.query.end ?? todayStr());
    const group = typeof req.query.group === 'string' ? req.query.group : undefined;
    const ids = await resolveGroup(req.user!, group);
    if (ids.length === 0) {
      res.json({ rows: [] });
      return;
    }

    const exceptionCodes = TIMECARD_CODES.filter((c) => c.exception).map((c) => c.code);
    const rows = await db.all(
      `SELECT u.id AS user_id, u.employee_id, u.name, t.payroll_date, r.code, r.activity,
              r.start_at, r.end_at, t.approved
       FROM timecard_rows r
       JOIN timecards t ON t.id = r.timecard_id
       JOIN users u ON u.id = t.user_id
       WHERE t.user_id IN (${placeholders(ids.length)})
         AND t.payroll_date BETWEEN ? AND ?
         AND r.code IN (${placeholders(exceptionCodes.length)})
       ORDER BY t.payroll_date DESC, u.name, r.start_at`,
      [...ids, start, end, ...exceptionCodes],
    );
    res.json({ rows });
  }),
);

/** Ad-hoc query tool over timecard rows. */
api.get(
  '/reports/query',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const start = dateSchema.parse(req.query.start ?? addDays(todayStr(), -7));
    const end = dateSchema.parse(req.query.end ?? todayStr());
    const group = typeof req.query.group === 'string' ? req.query.group : undefined;
    const code = typeof req.query.code === 'string' && req.query.code ? req.query.code : null;
    const activity = typeof req.query.activity === 'string' && req.query.activity ? req.query.activity : null;
    const ids = await resolveGroup(req.user!, group);
    if (ids.length === 0) {
      res.json({ rows: [] });
      return;
    }

    const clauses: string[] = [];
    const args: unknown[] = [...ids, start, end];
    if (code) {
      clauses.push('AND r.code = ?');
      args.push(code);
    }
    if (activity) {
      clauses.push('AND r.activity = ?');
      args.push(activity);
    }

    const rows = await db.all<any>(
      `SELECT u.employee_id, u.name, t.payroll_date, r.code, r.project, r.activity, r.start_at, r.end_at
       FROM timecard_rows r
       JOIN timecards t ON t.id = r.timecard_id
       JOIN users u ON u.id = t.user_id
       WHERE t.user_id IN (${placeholders(ids.length)})
         AND t.payroll_date BETWEEN ? AND ?
         ${clauses.join(' ')}
       ORDER BY t.payroll_date DESC, u.name, r.start_at
       LIMIT 1000`,
      args,
    );

    // The duration used to be computed with SQLite's julianday(), which has no
    // Postgres equivalent that reads the same. Both stamps are already in the
    // row, so subtracting them here is portable and one less thing the query
    // planner has to do.
    res.json({
      rows: rows.map((row) => ({ ...row, minutes: diffMinutes(row.start_at, row.end_at) })),
    });
  }),
);

// -------------------------------------------------------------------- admin
api.post(
  '/admin/groups',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const body = z
      .object({ name: z.string().min(1).max(40), userIds: z.array(z.number()).min(1) })
      .parse(req.body);
    const allowed = new Set(await visibleUserIds(req.user!));
    const members = body.userIds.filter((id) => allowed.has(id));
    if (members.length === 0) throw new HttpError(400, 'None of those employees are visible to you.');

    const existing = await db.get<{ id: number }>('SELECT id FROM groups WHERE name = ? AND owner_id = ?', [
      body.name,
      req.user!.id,
    ]);
    if (existing) throw new HttpError(409, 'You already have a group with that name.');

    const groupId = await db.insert('INSERT INTO groups (name, type, owner_id) VALUES (?, ?, ?)', [
      body.name,
      'CUSTOM',
      req.user!.id,
    ]);
    const values = members.map(() => '(?, ?)').join(', ');
    await db.run(
      `INSERT INTO group_members (group_id, user_id) VALUES ${values}`,
      members.flatMap((userId) => [groupId, userId]),
    );
    res.json({ ok: true, group: { id: groupId, name: `-${body.name}`, memberIds: members } });
  }),
);

api.delete(
  '/admin/groups/:name',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const name = req.params.name.replace(/^-/, '');
    const info = await db.run('DELETE FROM groups WHERE name = ? AND owner_id = ? AND type = ?', [
      name,
      req.user!.id,
      'CUSTOM',
    ]);
    if (info.changes === 0) throw new HttpError(404, 'You do not own a custom group with that name.');
    res.json({ ok: true });
  }),
);

api.get(
  '/admin/alternate',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const [current, delegatedToMe] = await Promise.all([
      db.get(
        `SELECT a.alternate_user_id AS id, u.employee_id, u.name
         FROM alternates a JOIN users u ON u.id = a.alternate_user_id WHERE a.user_id = ?`,
        [req.user!.id],
      ),
      db.all(
        `SELECT a.user_id AS id, u.employee_id, u.name
         FROM alternates a JOIN users u ON u.id = a.user_id WHERE a.alternate_user_id = ?`,
        [req.user!.id],
      ),
    ]);
    res.json({ current: current ?? null, delegatedToMe });
  }),
);

api.post(
  '/admin/alternate',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const body = z.object({ employeeId: z.string().min(1) }).parse(req.body);
    const target = await db.get<any>('SELECT * FROM users WHERE employee_id = ?', [body.employeeId]);
    if (!target) throw new HttpError(404, 'No employee with that ID.');
    if (target.id === req.user!.id) throw new HttpError(400, 'You cannot delegate to yourself.');
    if (target.role === 'ADVISOR') throw new HttpError(400, 'An alternate must be a supervisor.');

    const existing = await db.get<any>('SELECT * FROM alternates WHERE user_id = ?', [req.user!.id]);
    if (existing) {
      throw new HttpError(
        409,
        'You already have an alternate assigned. Remove the current alternate before assigning a new one.',
      );
    }
    await db.run('INSERT INTO alternates (user_id, alternate_user_id) VALUES (?, ?)', [
      req.user!.id,
      target.id,
    ]);
    res.json({ ok: true, message: `${target.name} can now see and manage your team.` });
  }),
);

api.delete(
  '/admin/alternate',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    await db.run('DELETE FROM alternates WHERE user_id = ?', [req.user!.id]);
    res.json({ ok: true });
  }),
);

api.post(
  '/admin/shift-rule',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const body = z
      .object({ userId: z.number(), shiftRule: z.string(), effectiveDate: dateSchema })
      .parse(req.body);
    if (!(await canManage(req.user!, body.userId))) {
      throw new HttpError(403, 'That employee is not on your team.');
    }
    if (!SHIFT_RULES.some((r) => r.code === body.shiftRule)) throw new HttpError(400, 'Unknown shift rule.');
    // A rule change may only take effect in the future, so it can never rewrite
    // how time already worked was judged.
    if (body.effectiveDate <= todayStr()) {
      throw new HttpError(400, 'A shift rule change can only be entered for a future date.');
    }
    await db.run(
      'INSERT INTO shift_rule_changes (user_id, shift_rule, effective_date, created_by) VALUES (?, ?, ?, ?)',
      [body.userId, body.shiftRule, body.effectiveDate, req.user!.id],
    );
    // Audited as well as stored. The row in shift_rule_changes says what will
    // happen; the audit entry says who decided it and when they decided it,
    // which is the half that gets asked about after a disputed payroll run.
    const subject = (await getUser(body.userId))?.name ?? `#${body.userId}`;
    await audit(req.user!.id, 'shift_rule', body.userId, 'CHANGE', {
      shiftRule: body.shiftRule,
      effectiveDate: body.effectiveDate,
      subject,
    });
    res.json({ ok: true, message: `Shift rule ${body.shiftRule} takes effect on ${body.effectiveDate}.` });
  }),
);

api.get(
  '/admin/rules-log',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    res.json({ entries: await rulesLog({ limit: Number.isFinite(limit) ? limit : 100 }) });
  }),
);

api.get(
  '/admin/audit',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const entity = typeof req.query.entity === 'string' ? req.query.entity : null;
    const rows = entity
      ? await db.all(
          `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
           WHERE a.entity = ? ORDER BY a.id DESC LIMIT 200`,
          [entity],
        )
      : await db.all(
          `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
           ORDER BY a.id DESC LIMIT 200`,
        );
    res.json({ entries: rows });
  }),
);
