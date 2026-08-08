/**
 * Routes for the planning and self-service half of the tool: the live intraday
 * picture, forecasting and coverage, analytics, shift swaps and extra hours.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { authenticate, requireSupervisor } from '../middleware/auth.js';
import { asyncRoute, HttpError } from '../middleware/errors.js';
import { intervalsOfDay, requiredStaffing } from '../domain/forecast.js';
import { addDays, todayStr } from '../domain/time.js';
import { canManage, placeholders, resolveGroup, visibleUserIds } from '../services/people.js';
import {
  acknowledgeAlert,
  assessLeave,
  payrollExport,
  releaseAlert,
} from '../services/planning.js';
import { intradaySnapshot } from '../services/intraday.js';
import {
  autoSchedule,
  coverageFor,
  getForecast,
  getSettings,
  saveForecast,
  saveSettings,
} from '../services/forecasting.js';
import { analyse } from '../services/analytics.js';
import {
  awardBid,
  createOffer,
  decideSwap,
  listBids,
  listOffers,
  listSwaps,
  placeBid,
  requestSwap,
  respondToSwap,
} from '../services/selfService.js';

export const planning = Router();

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date');
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Times use a 24 hour clock');

function groupOf(req: any): Promise<number[]> {
  const group = typeof req.query.group === 'string' ? req.query.group : undefined;
  return resolveGroup(req.user!, group);
}

/** The project a supervisor plans for, defaulting to their own. */
function projectOf(req: any): string {
  const explicit = typeof req.query.project === 'string' ? req.query.project : null;
  const projectId = explicit ?? req.user!.project_id;
  if (!projectId) throw new HttpError(400, 'No project is associated with your account.');
  return projectId;
}

// ---------------------------------------------------------------- intraday
planning.get(
  '/intraday',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    res.json(await intradaySnapshot(await groupOf(req)));
  }),
);

// ---------------------------------------------------------------- forecast
planning.get(
  '/forecast',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const date = dateSchema.parse(req.query.date ?? todayStr());
    const projectId = projectOf(req);
    const userIds = await groupOf(req);
    const [result, forecast] = await Promise.all([
      coverageFor({ projectId, date, userIds }),
      getForecast(projectId, date),
    ]);
    res.json({ ...result, projectId, forecast });
  }),
);

planning.put(
  '/forecast',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        date: dateSchema,
        project: z.string().optional(),
        rows: z.array(
          z.object({
            startTime: timeSchema,
            volume: z.number().min(0),
            ahtSeconds: z.number().int().min(1).max(7200),
          }),
        ),
      })
      .parse(req.body);

    const projectId = body.project ?? req.user!.project_id;
    if (!projectId) throw new HttpError(400, 'No project is associated with your account.');

    await saveForecast(projectId, body.date, body.rows, req.user!.id);
    res.json({
      ok: true,
      ...(await coverageFor({ projectId, date: body.date, userIds: await visibleUserIds(req.user!) })),
    });
  }),
);

planning.put(
  '/forecast/settings',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        project: z.string().optional(),
        serviceGoal: z.number().min(0.5).max(0.999),
        targetSeconds: z.number().int().min(1).max(600),
        shrinkage: z.number().min(0).max(0.9),
      })
      .parse(req.body);
    const projectId = body.project ?? req.user!.project_id;
    if (!projectId) throw new HttpError(400, 'No project is associated with your account.');
    await saveSettings(projectId, body, req.user!.id);
    res.json({ ok: true, settings: await getSettings(projectId) });
  }),
);

/** What a single interval would need — used by the planner's what-if control. */
planning.get('/forecast/staffing', authenticate, requireSupervisor, (req, res) => {
  const query = z
    .object({
      volume: z.coerce.number().min(0),
      ahtSeconds: z.coerce.number().min(1),
      serviceGoal: z.coerce.number().min(0.5).max(0.999).default(0.8),
      targetSeconds: z.coerce.number().min(1).default(20),
      shrinkage: z.coerce.number().min(0).max(0.9).default(0.3),
    })
    .parse(req.query);
  res.json(requiredStaffing(query));
});

planning.post(
  '/forecast/auto-schedule',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const body = z
      .object({ date: dateSchema, project: z.string().optional(), maxShifts: z.number().int().min(1).max(200).optional() })
      .parse(req.body);
    const projectId = body.project ?? req.user!.project_id;
    if (!projectId) throw new HttpError(400, 'No project is associated with your account.');

    const result = await autoSchedule({
      projectId,
      date: body.date,
      userIds: await visibleUserIds(req.user!),
      actorId: req.user!.id,
      maxShifts: body.maxShifts,
    });
    res.json(result);
  }),
);

planning.get('/forecast/intervals', authenticate, (_req, res) => {
  res.json({ intervals: intervalsOfDay() });
});

// --------------------------------------------------------------- analytics
planning.get(
  '/analytics',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const start = dateSchema.parse(req.query.start ?? addDays(todayStr(), -14));
    const end = dateSchema.parse(req.query.end ?? todayStr());
    res.json(await analyse({ userIds: await groupOf(req), start, end, actorId: req.user!.id }));
  }),
);

// ------------------------------------------------------------------- swaps
planning.get(
  '/swaps',
  authenticate,
  asyncRoute(async (req, res) => {
    const ids = req.user!.role === 'ADVISOR' ? [req.user!.id] : await visibleUserIds(req.user!);
    res.json({ swaps: await listSwaps(ids) });
  }),
);

/** Colleagues an advisor could reasonably swap with. */
planning.get(
  '/swaps/candidates',
  authenticate,
  asyncRoute(async (req, res) => {
    const date = dateSchema.parse(req.query.date ?? todayStr());
    const ids = (await visibleUserIds(req.user!)).filter((id) => id !== req.user!.id);
    if (ids.length === 0) {
      res.json({ candidates: [] });
      return;
    }
    const rows = await db.all(
      `SELECT DISTINCT u.id, u.name, u.employee_id, s.payroll_date
       FROM users u JOIN schedules s ON s.user_id = u.id
       WHERE u.id IN (${placeholders(ids.length)})
         AND u.role = 'ADVISOR' AND u.status = 'ACTIVE'
         AND s.payroll_date BETWEEN ? AND ?
       ORDER BY s.payroll_date, u.name LIMIT 200`,
      [...ids, date, addDays(date, 21)],
    );
    res.json({ candidates: rows });
  }),
);

planning.post(
  '/swaps',
  authenticate,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        requesterDate: dateSchema,
        counterpartyId: z.number().int(),
        counterpartyDate: dateSchema,
        reason: z.string().max(400).optional(),
      })
      .parse(req.body);

    const result = await requestSwap({ requesterId: req.user!.id, ...body });
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

planning.post(
  '/swaps/:id/respond',
  authenticate,
  asyncRoute(async (req, res) => {
    const body = z.object({ accept: z.boolean() }).parse(req.body);
    const result = await respondToSwap(Number(req.params.id), req.user!.id, body.accept);
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

planning.post(
  '/swaps/:id/decide',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const body = z.object({ approve: z.boolean() }).parse(req.body);
    const result = await decideSwap(Number(req.params.id), req.user!.id, body.approve);
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

// ------------------------------------------------------------- extra hours
planning.get(
  '/extra-hours',
  authenticate,
  asyncRoute(async (req, res) => {
    res.json({ offers: await listOffers(req.user!.project_id, req.user!.id) });
  }),
);

planning.get(
  '/extra-hours/:id/bids',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    res.json({ bids: await listBids(Number(req.params.id)) });
  }),
);

planning.post(
  '/extra-hours',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        date: dateSchema,
        startTime: timeSchema,
        endTime: timeSchema,
        slots: z.number().int().min(1).max(100),
        note: z.string().max(300).optional(),
        project: z.string().optional(),
      })
      .parse(req.body);
    const projectId = body.project ?? req.user!.project_id;
    if (!projectId) throw new HttpError(400, 'No project is associated with your account.');
    res.json(await createOffer({ ...body, projectId, actorId: req.user!.id }));
  }),
);

planning.post(
  '/extra-hours/:id/bid',
  authenticate,
  asyncRoute(async (req, res) => {
    const result = await placeBid(Number(req.params.id), req.user!.id);
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

planning.post(
  '/extra-hours/bids/:bidId/award',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const bid = await db.get<{ user_id: number }>('SELECT user_id FROM extra_hours_bids WHERE id = ?', [
      Number(req.params.bidId),
    ]);
    if (!bid) throw new HttpError(404, 'No such bid.');
    if (!(await canManage(req.user!, bid.user_id))) {
      throw new HttpError(403, 'That advisor is not on your team.');
    }

    const result = await awardBid(Number(req.params.bidId), req.user!.id);
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

// ------------------------------------------------------- coverage-aware leave
/**
 * What approving a time-off request would do to cover.
 *
 * Read-only and advisory: the screen shows it beside the Approve button, and
 * the supervisor still decides.
 */
planning.get(
  '/absence/requests/:id/impact',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const request = await db.get<any>('SELECT * FROM time_off_requests WHERE id = ?', [
      Number(req.params.id),
    ]);
    if (!request) throw new HttpError(404, 'No such request.');
    if (!(await canManage(req.user!, request.user_id))) {
      throw new HttpError(403, 'That request is not yours to look at.');
    }

    const advisor = await db.get<{ project_id: string | null }>(
      'SELECT project_id FROM users WHERE id = ?',
      [request.user_id],
    );
    res.json(
      await assessLeave({
        userId: request.user_id,
        start: request.start_date,
        end: request.end_date,
        userIds: await visibleUserIds(req.user!),
        projectId: advisor?.project_id ?? req.user!.project_id,
      }),
    );
  }),
);

// ------------------------------------------------------------ alert handling
planning.post(
  '/alerts/:key/ack',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const body = z.object({ userId: z.number().int(), note: z.string().max(300).optional() }).parse(req.body);
    if (!(await canManage(req.user!, body.userId))) {
      throw new HttpError(403, 'That advisor is not on your team.');
    }
    const result = await acknowledgeAlert({
      alertKey: req.params.key,
      userId: body.userId,
      payrollDate: todayStr(),
      ackedBy: req.user!.id,
      note: body.note,
    });
    res.json(result);
  }),
);

planning.delete(
  '/alerts/:key/ack',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const released = await releaseAlert(req.params.key, todayStr());
    res.json({ ok: released, message: released ? 'Handed back.' : 'Nobody had picked that up.' });
  }),
);

// ------------------------------------------------------------ payroll export
/**
 * One row per advisor, per day, per code. The last mile between this tool and
 * whatever actually pays people.
 */
planning.get(
  '/payroll/export',
  authenticate,
  requireSupervisor,
  asyncRoute(async (req, res) => {
    const start = dateSchema.parse(req.query.start ?? todayStr());
    const end = dateSchema.parse(req.query.end ?? start);
    const rows = await payrollExport({
      userIds: await groupOf(req),
      start,
      end,
      approvedOnly: req.query.approvedOnly !== 'false',
    });
    res.json({ rows, start, end, approvedOnly: req.query.approvedOnly !== 'false' });
  }),
);
