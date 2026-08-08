/**
 * The live event stream and the notification list that backs it.
 *
 * These are two halves of the same idea. The stream is what is happening now,
 * for a screen someone is looking at; the notifications are what happened while
 * they were not.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { authenticate, authenticateStream, requireSupervisor } from '../middleware/auth.js';
import { asyncRoute, HttpError } from '../middleware/errors.js';
import { canManage, resolveGroup } from '../services/people.js';
import { emit, listNotifications, markAllRead, subscribe, subscriberCount } from '../services/events.js';
import { payrollSummary, setApproval } from '../services/timecards.js';
import { uncleanReason } from '../domain/bulkApproval.js';
import { todayStr } from '../domain/time.js';

export const events = Router();

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date');

// ------------------------------------------------------------------ stream
events.get('/events', authenticateStream, (req, res) => {
  const lastEventId = Number(req.headers['last-event-id'] ?? req.query.lastEventId ?? 0) || 0;
  const teardown = subscribe(req.user!, res, lastEventId);
  req.on('close', teardown);
});

events.get('/events/status', authenticate, (_req, res) => {
  res.json({ connections: subscriberCount() });
});

// ----------------------------------------------------------- notifications
events.get('/notifications', authenticate, (req, res) => {
  const items = listNotifications(req.user!.id);
  res.json({ notifications: items, unread: items.filter((n) => !n.read).length });
});

events.post('/notifications/read-all', authenticate, (req, res) => {
  res.json({ ok: true, marked: markAllRead(req.user!.id) });
});

events.post('/notifications/:id/read', authenticate, (req, res) => {
  const info = db
    .prepare('UPDATE messages SET read_flag = 1 WHERE id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user!.id);
  if (info.changes === 0) throw new HttpError(404, 'No such notification.');
  res.json({ ok: true });
});

// ------------------------------------------------------------ bulk approval
/**
 * Approve every clean card in one gesture.
 *
 * "Clean" is the important word and it is decided here, not by the client: a
 * card with a validation error, an assumed-off end, or a shift still running is
 * never included, however the request was framed. Bulk approval is a shortcut
 * through the boring cards, not a way around the checks — a supervisor
 * approving forty cards at once has, in practice, read none of them, so the
 * ones worth reading must be the ones this refuses to touch.
 */
events.post(
  '/payroll/approve-clean',
  authenticate,
  requireSupervisor,
  asyncRoute((req, res) => {
    const body = z
      .object({
        group: z.string().optional(),
        start: dateSchema,
        end: dateSchema,
        /** Optional allow-list, so the screen can approve only what is selected. */
        keys: z.array(z.string()).optional(),
      })
      .parse(req.body);

    const ids = resolveGroup(req.user!, body.group);
    const rows = payrollSummary({
      userIds: ids,
      start: body.start,
      end: body.end,
      actorId: req.user!.id,
    });

    const allowList = body.keys ? new Set(body.keys) : null;
    const today = todayStr();
    const approved: string[] = [];
    const skipped: { key: string; name: string; date: string; reason: string }[] = [];

    for (const row of rows) {
      const key = `${row.userId}-${row.payrollDate}`;
      if (allowList && !allowList.has(key)) continue;
      if (row.approved) continue;

      const reason = uncleanReason(row, today);
      if (reason) {
        skipped.push({ key, name: row.name, date: row.payrollDate, reason });
        continue;
      }
      if (!canManage(req.user!, row.userId)) {
        skipped.push({ key, name: row.name, date: row.payrollDate, reason: 'not on your team' });
        continue;
      }

      const result = setApproval({
        userId: row.userId,
        date: row.payrollDate,
        approved: true,
        actorId: req.user!.id,
        actorRole: req.user!.role,
      });
      if (result.ok) approved.push(key);
      else skipped.push({ key, name: row.name, date: row.payrollDate, reason: result.message });
    }

    if (approved.length > 0) {
      emit('timecard.approved', req.user!.id, `${req.user!.name} approved ${approved.length} timecards`, {
        count: approved.length,
        bulk: true,
      });
    }

    res.json({
      ok: true,
      approved,
      skipped,
      message:
        approved.length === 0
          ? 'Nothing was clean enough to approve without reading it.'
          : `Approved ${approved.length} clean timecard${approved.length === 1 ? '' : 's'}` +
            (skipped.length > 0 ? `, left ${skipped.length} for you to read.` : '.'),
    });
  }),
);
