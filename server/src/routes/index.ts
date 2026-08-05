import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../db/index.js';
import { authenticate, requireRole, requireSupervisor, signToken } from '../middleware/auth.js';
import { asyncRoute, HttpError } from '../middleware/errors.js';
import {
  ACTIVITIES,
  EDIT_WINDOW_DAYS,
  MANUAL_CHECK_STATUSES,
  PRODUCT,
  ROLE_LABELS,
  SCHEDULE_ACTIVITIES,
  SHIFT_RULES,
  TIMECARD_CODES,
} from '../domain/reference.js';
import { buildAdherenceReport, punctuality } from '../domain/adherence.js';
import { evaluateEdit } from '../domain/editWindow.js';
import { addDays, todayStr } from '../domain/time.js';
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
import { applyGroupException, getShifts, getShiftsInRange, saveShifts } from '../services/scheduling.js';
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
  asyncRoute((req, res) => {
    const body = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const user = getUserByEmail(body.email);
    if (!user || !bcrypt.compareSync(body.password, user.password_hash)) {
      throw new HttpError(401, 'That email address and password do not match an account.');
    }
    if (user.status !== 'ACTIVE') {
      throw new HttpError(
        403,
        `Your employment status is ${user.status}. Access is restricted until your HR record shows Active.`,
      );
    }
    const { password_hash: _ignored, ...safe } = user;
    res.json({ token: signToken(user.id), user: shapeUser(safe) });
  }),
);

api.get('/auth/me', authenticate, (req, res) => {
  res.json({ user: shapeUser(req.user!) });
});

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
    editWindowDays: EDIT_WINDOW_DAYS[u.role as keyof typeof EDIT_WINDOW_DAYS],
    isSupervisor: u.role !== 'ADVISOR',
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
    today: todayStr(),
  });
});

// ------------------------------------------------------------------ people
api.get('/people/groups', authenticate, (req, res) => {
  res.json({ groups: listGroups(req.user!) });
});

api.get('/people', authenticate, (req, res) => {
  const group = typeof req.query.group === 'string' ? req.query.group : undefined;
  const ids = resolveGroup(req.user!, group);
  if (ids.length === 0) {
    res.json({ people: [] });
    return;
  }
  const people = db
    .prepare(
      `SELECT u.id, u.employee_id, u.name, u.email, u.role, u.project_id, u.department_code, u.status,
              u.shift_rule, m.name AS manager_name
       FROM users u LEFT JOIN users m ON m.id = u.manager_id
       WHERE u.id IN (${placeholders(ids.length)}) ORDER BY u.name`,
    )
    .all(...ids);
  res.json({ people });
});

api.get('/people/:id', authenticate, (req, res) => {
  const id = Number(req.params.id);
  if (!canManage(req.user!, id)) throw new HttpError(403, 'You cannot view that employee.');
  const user = getUser(id);
  if (!user) throw new HttpError(404, 'No such employee.');
  const today = todayStr();
  const project = user.project_id
    ? db.prepare('SELECT * FROM projects WHERE activity_id = ?').get(user.project_id)
    : null;
  res.json({
    person: shapeUser(user),
    project,
    shiftRule: effectiveShiftRule(id, today),
    shiftRuleHistory: pendingShiftRuleChanges(id, today),
    accruals: db.prepare('SELECT accrual_type, balance_hours, as_of FROM accruals WHERE user_id = ?').all(id),
  });
});

// ------------------------------------------------------------------- clock
api.get('/clock', authenticate, (req, res) => {
  res.json(getClockState(req.user!.id));
});

api.post(
  '/clock/punch',
  authenticate,
  asyncRoute((req, res) => {
    const body = z
      .object({ type: z.enum(['ON', 'OFF', 'CHANGE']), activity: z.string().nullish() })
      .parse(req.body);
    const result = punch({
      userId: req.user!.id,
      type: body.type,
      activity: body.activity ?? null,
      actorId: req.user!.id,
    });
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

// --------------------------------------------------------------- schedules
api.get('/schedules/:userId', authenticate, (req, res) => {
  const userId = Number(req.params.userId);
  if (!canManage(req.user!, userId)) throw new HttpError(403, 'You cannot view that schedule.');
  const start = dateSchema.parse(req.query.start ?? todayStr());
  const end = dateSchema.parse(req.query.end ?? start);
  res.json({ days: getShiftsInRange(userId, start, end) });
});

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
  asyncRoute((req, res) => {
    const userId = Number(req.params.userId);
    const date = dateSchema.parse(req.params.date);
    if (!canManage(req.user!, userId)) throw new HttpError(403, 'You cannot edit that schedule.');
    const body = z.object({ shifts: z.array(shiftSchema) }).parse(req.body);
    const result = saveShifts({
      userId,
      date,
      shifts: body.shifts as any,
      actorId: req.user!.id,
    });
    // Re-derive the card so schedule-driven exceptions follow the new plan.
    if (result.ok) generateTimecard({ userId, date, actorId: req.user!.id });
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

api.post(
  '/schedules/group-exception',
  authenticate,
  requireSupervisor,
  asyncRoute((req, res) => {
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

    const ids = body.userIds ?? resolveGroup(req.user!, body.group);
    const allowed = new Set(visibleUserIds(req.user!));
    const targets = ids.filter((id) => allowed.has(id));
    if (targets.length === 0) throw new HttpError(400, 'No employees in range for that group.');

    const result = applyGroupException({
      userIds: targets,
      date: body.date,
      activityKey: body.activityKey as any,
      startTime: body.startTime,
      endTime: body.endTime,
      actorId: req.user!.id,
    });
    for (const userId of result.applied) {
      generateTimecard({ userId, date: body.date, actorId: req.user!.id });
    }
    res.json(result);
  }),
);

// --------------------------------------------------------------- timecards
api.get('/timecards/:userId/:date', authenticate, (req, res) => {
  const userId = Number(req.params.userId);
  const date = dateSchema.parse(req.params.date);
  if (!canManage(req.user!, userId)) throw new HttpError(403, 'You cannot view that timecard.');

  const view = viewTimecard({ userId, date, actorId: req.user!.id });
  const decision = evaluateEdit({
    role: req.user!.role,
    payrollDate: date,
    today: todayStr(),
    protectDate: view?.protectDate ?? null,
  });
  res.json({ timecard: view, decision, shifts: getShifts(userId, date) });
});

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
  asyncRoute((req, res) => {
    const userId = Number(req.params.userId);
    const date = dateSchema.parse(req.params.date);
    if (!canManage(req.user!, userId)) throw new HttpError(403, 'You cannot edit that timecard.');
    const body = z.object({ rows: z.array(rowSchema) }).parse(req.body);
    const result = saveTimecard({
      userId,
      date,
      rows: body.rows,
      actorId: req.user!.id,
      actorRole: req.user!.role,
    });
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

api.post(
  '/timecards/:userId/:date/approve',
  authenticate,
  requireSupervisor,
  asyncRoute((req, res) => {
    const userId = Number(req.params.userId);
    const date = dateSchema.parse(req.params.date);
    if (!canManage(req.user!, userId)) throw new HttpError(403, 'You cannot approve that timecard.');
    const body = z.object({ approved: z.boolean() }).parse(req.body);
    const result = setApproval({
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
  asyncRoute((req, res) => {
    const userId = Number(req.params.userId);
    const date = dateSchema.parse(req.params.date);
    if (!canManage(req.user!, userId)) throw new HttpError(403, 'You cannot rebuild that timecard.');
    generateTimecard({ userId, date, actorId: req.user!.id, force: true });
    res.json({ ok: true, timecard: viewTimecard({ userId, date, autoGenerate: false }) });
  }),
);

api.post(
  '/timecards/:userId/:date/manual-check',
  authenticate,
  requireSupervisor,
  asyncRoute((req, res) => {
    const userId = Number(req.params.userId);
    const date = dateSchema.parse(req.params.date);
    if (!canManage(req.user!, userId)) throw new HttpError(403, 'You cannot change that timecard.');
    const body = z.object({ status: z.enum(MANUAL_CHECK_STATUSES) }).parse(req.body);
    const result = setManualCheck({ userId, date, status: body.status, actorId: req.user!.id });
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

// ----------------------------------------------------------------- payroll
api.get('/payroll/summary', authenticate, requireSupervisor, (req, res) => {
  const start = dateSchema.parse(req.query.start ?? todayStr());
  const end = dateSchema.parse(req.query.end ?? start);
  const group = typeof req.query.group === 'string' ? req.query.group : undefined;
  const ids = resolveGroup(req.user!, group);
  res.json({
    rows: payrollSummary({ userIds: ids, start, end, actorId: req.user!.id }),
    editWindowDays: EDIT_WINDOW_DAYS[req.user!.role],
  });
});

api.get('/payroll/periods', authenticate, (req, res) => {
  res.json({
    periods: db
      .prepare('SELECT * FROM payroll_periods WHERE region = ? ORDER BY start_date DESC')
      .all(req.user!.region),
  });
});

api.post(
  '/payroll/run',
  authenticate,
  requireRole('OPS_MANAGER', 'ADMIN'),
  asyncRoute((req, res) => {
    const body = z.object({ start: dateSchema, end: dateSchema }).parse(req.body);
    const result = runPayroll({
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
api.get('/absence/accruals', authenticate, (req, res) => {
  const userId = req.query.userId ? Number(req.query.userId) : req.user!.id;
  if (!canManage(req.user!, userId)) throw new HttpError(403, 'You cannot view those balances.');
  res.json({
    accruals: db
      .prepare('SELECT accrual_type, balance_hours, as_of FROM accruals WHERE user_id = ?')
      .all(userId),
  });
});

api.get('/absence/requests', authenticate, (req, res) => {
  const ids = req.user!.role === 'ADVISOR' ? [req.user!.id] : visibleUserIds(req.user!);
  res.json({
    requests: db
      .prepare(
        `SELECT r.*, u.name AS user_name, u.employee_id
         FROM time_off_requests r JOIN users u ON u.id = r.user_id
         WHERE r.user_id IN (${placeholders(ids.length)})
         ORDER BY r.start_date DESC LIMIT 200`,
      )
      .all(...ids),
  });
});

api.post(
  '/absence/requests',
  authenticate,
  asyncRoute((req, res) => {
    const body = z
      .object({
        accrualType: z.enum(['VACATION', 'SICK', 'UNPAID']),
        startDate: dateSchema,
        endDate: dateSchema,
        hours: z.number().positive(),
        reason: z.string().max(500).optional(),
      })
      .parse(req.body);

    if (body.endDate < body.startDate) throw new HttpError(400, 'The end date is before the start date.');

    // Accrual enforcement: a request cannot exceed what has actually accrued.
    if (body.accrualType !== 'UNPAID') {
      const balance = db
        .prepare('SELECT balance_hours FROM accruals WHERE user_id = ? AND accrual_type = ?')
        .get(req.user!.id, body.accrualType) as { balance_hours: number } | undefined;
      const available = balance?.balance_hours ?? 0;
      if (body.hours > available) {
        throw new HttpError(
          400,
          `You have ${available} hours of ${body.accrualType.toLowerCase()} accrued and asked for ${body.hours}.`,
        );
      }
    }

    const info = db
      .prepare(
        `INSERT INTO time_off_requests (user_id, accrual_type, start_date, end_date, hours, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(req.user!.id, body.accrualType, body.startDate, body.endDate, body.hours, body.reason ?? null);
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  }),
);

api.post(
  '/absence/requests/:id/decision',
  authenticate,
  requireSupervisor,
  asyncRoute((req, res) => {
    const id = Number(req.params.id);
    const body = z.object({ status: z.enum(['APPROVED', 'DECLINED']) }).parse(req.body);
    const request = db.prepare('SELECT * FROM time_off_requests WHERE id = ?').get(id) as any;
    if (!request) throw new HttpError(404, 'No such request.');
    if (!canManage(req.user!, request.user_id)) throw new HttpError(403, 'That request is not yours to decide.');

    db.prepare(
      "UPDATE time_off_requests SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?",
    ).run(body.status, req.user!.id, id);

    if (body.status === 'APPROVED' && request.accrual_type !== 'UNPAID') {
      db.prepare(
        'UPDATE accruals SET balance_hours = balance_hours - ? WHERE user_id = ? AND accrual_type = ?',
      ).run(request.hours, request.user_id, request.accrual_type);
    }
    res.json({ ok: true });
  }),
);

// ------------------------------------------------------------------- home
api.get('/messages', authenticate, (req, res) => {
  res.json({
    messages: db
      .prepare('SELECT * FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(req.user!.id),
  });
});

api.post('/messages/:id/read', authenticate, (req, res) => {
  db.prepare('UPDATE messages SET read_flag = 1 WHERE id = ? AND user_id = ?').run(
    Number(req.params.id),
    req.user!.id,
  );
  res.json({ ok: true });
});

// ------------------------------------------------------------------ reports
api.get('/reports/adherence', authenticate, (req, res) => {
  const userId = Number(req.query.userId ?? req.user!.id);
  const date = dateSchema.parse(req.query.date ?? addDays(todayStr(), -1));
  if (!canManage(req.user!, userId)) throw new HttpError(403, 'You cannot view that report.');

  const shifts = getShifts(userId, date);
  const view = viewTimecard({ userId, date, actorId: req.user!.id });
  const rows = view?.rows ?? [];
  res.json({
    user: shapeUser(getUser(userId)),
    date,
    report: buildAdherenceReport({ shifts, rows }),
    punctuality: punctuality(shifts, rows),
    timecard: view,
    shifts,
  });
});

/** Non-worked exception report: every exception code across a group and range. */
api.get('/reports/exceptions', authenticate, requireSupervisor, (req, res) => {
  const start = dateSchema.parse(req.query.start ?? addDays(todayStr(), -7));
  const end = dateSchema.parse(req.query.end ?? todayStr());
  const group = typeof req.query.group === 'string' ? req.query.group : undefined;
  const ids = resolveGroup(req.user!, group);
  if (ids.length === 0) {
    res.json({ rows: [] });
    return;
  }

  const exceptionCodes = TIMECARD_CODES.filter((c) => c.exception).map((c) => c.code);
  const rows = db
    .prepare(
      `SELECT u.id AS user_id, u.employee_id, u.name, t.payroll_date, r.code, r.activity,
              r.start_at, r.end_at, t.approved
       FROM timecard_rows r
       JOIN timecards t ON t.id = r.timecard_id
       JOIN users u ON u.id = t.user_id
       WHERE t.user_id IN (${placeholders(ids.length)})
         AND t.payroll_date BETWEEN ? AND ?
         AND r.code IN (${placeholders(exceptionCodes.length)})
       ORDER BY t.payroll_date DESC, u.name, r.start_at`,
    )
    .all(...ids, start, end, ...exceptionCodes);
  res.json({ rows });
});

/** Ad-hoc query tool over timecard rows. */
api.get('/reports/query', authenticate, requireSupervisor, (req, res) => {
  const start = dateSchema.parse(req.query.start ?? addDays(todayStr(), -7));
  const end = dateSchema.parse(req.query.end ?? todayStr());
  const group = typeof req.query.group === 'string' ? req.query.group : undefined;
  const code = typeof req.query.code === 'string' && req.query.code ? req.query.code : null;
  const activity = typeof req.query.activity === 'string' && req.query.activity ? req.query.activity : null;
  const ids = resolveGroup(req.user!, group);
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

  const rows = db
    .prepare(
      `SELECT u.employee_id, u.name, t.payroll_date, r.code, r.project, r.activity, r.start_at, r.end_at,
              (julianday(replace(r.end_at,' ','T')) - julianday(replace(r.start_at,' ','T'))) * 1440 AS minutes
       FROM timecard_rows r
       JOIN timecards t ON t.id = r.timecard_id
       JOIN users u ON u.id = t.user_id
       WHERE t.user_id IN (${placeholders(ids.length)})
         AND t.payroll_date BETWEEN ? AND ?
         ${clauses.join(' ')}
       ORDER BY t.payroll_date DESC, u.name, r.start_at
       LIMIT 1000`,
    )
    .all(...args);
  res.json({ rows });
});

// -------------------------------------------------------------------- admin
api.post(
  '/admin/groups',
  authenticate,
  requireSupervisor,
  asyncRoute((req, res) => {
    const body = z
      .object({ name: z.string().min(1).max(40), userIds: z.array(z.number()).min(1) })
      .parse(req.body);
    const allowed = new Set(visibleUserIds(req.user!));
    const members = body.userIds.filter((id) => allowed.has(id));
    if (members.length === 0) throw new HttpError(400, 'None of those employees are visible to you.');

    const existing = db
      .prepare('SELECT id FROM groups WHERE name = ? AND owner_id = ?')
      .get(body.name, req.user!.id) as { id: number } | undefined;
    if (existing) throw new HttpError(409, 'You already have a group with that name.');

    const info = db
      .prepare('INSERT INTO groups (name, type, owner_id) VALUES (?, ?, ?)')
      .run(body.name, 'CUSTOM', req.user!.id);
    const groupId = Number(info.lastInsertRowid);
    const insert = db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)');
    for (const userId of members) insert.run(groupId, userId);
    res.json({ ok: true, group: { id: groupId, name: `-${body.name}`, memberIds: members } });
  }),
);

api.delete(
  '/admin/groups/:name',
  authenticate,
  requireSupervisor,
  asyncRoute((req, res) => {
    const name = req.params.name.replace(/^-/, '');
    const info = db
      .prepare('DELETE FROM groups WHERE name = ? AND owner_id = ? AND type = ?')
      .run(name, req.user!.id, 'CUSTOM');
    if (info.changes === 0) throw new HttpError(404, 'You do not own a custom group with that name.');
    res.json({ ok: true });
  }),
);

api.get('/admin/alternate', authenticate, requireSupervisor, (req, res) => {
  const current = db
    .prepare(
      `SELECT a.alternate_user_id AS id, u.employee_id, u.name
       FROM alternates a JOIN users u ON u.id = a.alternate_user_id WHERE a.user_id = ?`,
    )
    .get(req.user!.id);
  const delegatedToMe = db
    .prepare(
      `SELECT a.user_id AS id, u.employee_id, u.name
       FROM alternates a JOIN users u ON u.id = a.user_id WHERE a.alternate_user_id = ?`,
    )
    .all(req.user!.id);
  res.json({ current: current ?? null, delegatedToMe });
});

api.post(
  '/admin/alternate',
  authenticate,
  requireSupervisor,
  asyncRoute((req, res) => {
    const body = z.object({ employeeId: z.string().min(1) }).parse(req.body);
    const target = db.prepare('SELECT * FROM users WHERE employee_id = ?').get(body.employeeId) as any;
    if (!target) throw new HttpError(404, 'No employee with that ID.');
    if (target.id === req.user!.id) throw new HttpError(400, 'You cannot delegate to yourself.');
    if (target.role === 'ADVISOR') throw new HttpError(400, 'An alternate must be a supervisor.');

    const existing = db.prepare('SELECT * FROM alternates WHERE user_id = ?').get(req.user!.id) as any;
    if (existing) {
      throw new HttpError(
        409,
        'You already have an alternate assigned. Remove the current alternate before assigning a new one.',
      );
    }
    db.prepare('INSERT INTO alternates (user_id, alternate_user_id) VALUES (?, ?)').run(
      req.user!.id,
      target.id,
    );
    res.json({ ok: true, message: `${target.name} can now see and manage your team.` });
  }),
);

api.delete('/admin/alternate', authenticate, requireSupervisor, (req, res) => {
  db.prepare('DELETE FROM alternates WHERE user_id = ?').run(req.user!.id);
  res.json({ ok: true });
});

api.post(
  '/admin/shift-rule',
  authenticate,
  requireSupervisor,
  asyncRoute((req, res) => {
    const body = z
      .object({ userId: z.number(), shiftRule: z.string(), effectiveDate: dateSchema })
      .parse(req.body);
    if (!canManage(req.user!, body.userId)) throw new HttpError(403, 'That employee is not on your team.');
    if (!SHIFT_RULES.some((r) => r.code === body.shiftRule)) throw new HttpError(400, 'Unknown shift rule.');
    // A rule change may only take effect in the future, so it can never rewrite
    // how time already worked was judged.
    if (body.effectiveDate <= todayStr()) {
      throw new HttpError(400, 'A shift rule change can only be entered for a future date.');
    }
    db.prepare(
      'INSERT INTO shift_rule_changes (user_id, shift_rule, effective_date, created_by) VALUES (?, ?, ?, ?)',
    ).run(body.userId, body.shiftRule, body.effectiveDate, req.user!.id);
    res.json({ ok: true, message: `Shift rule ${body.shiftRule} takes effect on ${body.effectiveDate}.` });
  }),
);

api.get('/admin/audit', authenticate, requireSupervisor, (req, res) => {
  const entity = typeof req.query.entity === 'string' ? req.query.entity : null;
  const rows = entity
    ? db
        .prepare(
          `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
           WHERE a.entity = ? ORDER BY a.id DESC LIMIT 200`,
        )
        .all(entity)
    : db
        .prepare(
          `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
           ORDER BY a.id DESC LIMIT 200`,
        )
        .all();
  res.json({ entries: rows });
});
