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
import { canManage, resolveGroup, visibleUserIds } from '../services/people.js';
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

function groupOf(req: any): number[] {
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
planning.get('/intraday', authenticate, requireSupervisor, (req, res) => {
  res.json(intradaySnapshot(groupOf(req)));
});

// ---------------------------------------------------------------- forecast
planning.get('/forecast', authenticate, requireSupervisor, (req, res) => {
  const date = dateSchema.parse(req.query.date ?? todayStr());
  const projectId = projectOf(req);
  const userIds = groupOf(req);
  const result = coverageFor({ projectId, date, userIds });
  res.json({ ...result, projectId, forecast: getForecast(projectId, date) });
});

planning.put(
  '/forecast',
  authenticate,
  requireSupervisor,
  asyncRoute((req, res) => {
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

    saveForecast(projectId, body.date, body.rows, req.user!.id);
    res.json({
      ok: true,
      ...coverageFor({ projectId, date: body.date, userIds: visibleUserIds(req.user!) }),
    });
  }),
);

planning.put(
  '/forecast/settings',
  authenticate,
  requireSupervisor,
  asyncRoute((req, res) => {
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
    saveSettings(projectId, body, req.user!.id);
    res.json({ ok: true, settings: getSettings(projectId) });
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
  asyncRoute((req, res) => {
    const body = z
      .object({ date: dateSchema, project: z.string().optional(), maxShifts: z.number().int().min(1).max(200).optional() })
      .parse(req.body);
    const projectId = body.project ?? req.user!.project_id;
    if (!projectId) throw new HttpError(400, 'No project is associated with your account.');

    const result = autoSchedule({
      projectId,
      date: body.date,
      userIds: visibleUserIds(req.user!),
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
planning.get('/analytics', authenticate, requireSupervisor, (req, res) => {
  const start = dateSchema.parse(req.query.start ?? addDays(todayStr(), -14));
  const end = dateSchema.parse(req.query.end ?? todayStr());
  res.json(analyse({ userIds: groupOf(req), start, end, actorId: req.user!.id }));
});

// ------------------------------------------------------------------- swaps
planning.get('/swaps', authenticate, (req, res) => {
  const ids = req.user!.role === 'ADVISOR' ? [req.user!.id] : visibleUserIds(req.user!);
  res.json({ swaps: listSwaps(ids) });
});

/** Colleagues an advisor could reasonably swap with. */
planning.get('/swaps/candidates', authenticate, (req, res) => {
  const date = dateSchema.parse(req.query.date ?? todayStr());
  const ids = visibleUserIds(req.user!).filter((id) => id !== req.user!.id);
  if (ids.length === 0) {
    res.json({ candidates: [] });
    return;
  }
  const rows = db
    .prepare(
      `SELECT DISTINCT u.id, u.name, u.employee_id, s.payroll_date
       FROM users u JOIN schedules s ON s.user_id = u.id
       WHERE u.id IN (${ids.map(() => '?').join(',')})
         AND u.role = 'ADVISOR' AND u.status = 'ACTIVE'
         AND s.payroll_date BETWEEN ? AND ?
       ORDER BY s.payroll_date, u.name LIMIT 200`,
    )
    .all(...ids, date, addDays(date, 21));
  res.json({ candidates: rows });
});

planning.post(
  '/swaps',
  authenticate,
  asyncRoute((req, res) => {
    const body = z
      .object({
        requesterDate: dateSchema,
        counterpartyId: z.number().int(),
        counterpartyDate: dateSchema,
        reason: z.string().max(400).optional(),
      })
      .parse(req.body);

    const result = requestSwap({ requesterId: req.user!.id, ...body });
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

planning.post(
  '/swaps/:id/respond',
  authenticate,
  asyncRoute((req, res) => {
    const body = z.object({ accept: z.boolean() }).parse(req.body);
    const result = respondToSwap(Number(req.params.id), req.user!.id, body.accept);
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

planning.post(
  '/swaps/:id/decide',
  authenticate,
  requireSupervisor,
  asyncRoute((req, res) => {
    const body = z.object({ approve: z.boolean() }).parse(req.body);
    const result = decideSwap(Number(req.params.id), req.user!.id, body.approve);
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

// ------------------------------------------------------------- extra hours
planning.get('/extra-hours', authenticate, (req, res) => {
  res.json({ offers: listOffers(req.user!.project_id, req.user!.id) });
});

planning.get('/extra-hours/:id/bids', authenticate, requireSupervisor, (req, res) => {
  res.json({ bids: listBids(Number(req.params.id)) });
});

planning.post(
  '/extra-hours',
  authenticate,
  requireSupervisor,
  asyncRoute((req, res) => {
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
    res.json(createOffer({ ...body, projectId, actorId: req.user!.id }));
  }),
);

planning.post(
  '/extra-hours/:id/bid',
  authenticate,
  asyncRoute((req, res) => {
    const result = placeBid(Number(req.params.id), req.user!.id);
    res.status(result.ok ? 200 : 400).json(result);
  }),
);

planning.post(
  '/extra-hours/bids/:bidId/award',
  authenticate,
  requireSupervisor,
  asyncRoute((req, res) => {
    const bid = db
      .prepare('SELECT user_id FROM extra_hours_bids WHERE id = ?')
      .get(Number(req.params.bidId)) as { user_id: number } | undefined;
    if (!bid) throw new HttpError(404, 'No such bid.');
    if (!canManage(req.user!, bid.user_id)) throw new HttpError(403, 'That advisor is not on your team.');

    const result = awardBid(Number(req.params.bidId), req.user!.id);
    res.status(result.ok ? 200 : 400).json(result);
  }),
);
