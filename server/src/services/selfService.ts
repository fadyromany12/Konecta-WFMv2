/**
 * Advisor self-service: swapping shifts and bidding for extra hours.
 *
 * Both flows move work off supervisors and onto the people whose time it is,
 * but neither bypasses them — a swap needs the other advisor *and* a
 * supervisor, and a bid still has to be awarded. The point is to remove the
 * chasing, not the control.
 */

import { audit, db, transact } from '../db/index.js';
import { addDays, type DateStr } from '../domain/time.js';
import { getShifts, saveShifts } from './scheduling.js';
import { placeholders } from './people.js';
import { generateTimecard } from './timecards.js';
import { emit, notify, supervisorsOf } from './events.js';

/** Name for a user id, for notification copy. Falls back to the id. */
function nameOf(userId: number): string {
  const row = db.prepare('SELECT name FROM users WHERE id = ?').get(userId) as { name: string } | undefined;
  return row?.name ?? `#${userId}`;
}

export interface SwapRequest {
  id: number;
  requesterId: number;
  requesterName: string;
  requesterDate: DateStr;
  counterpartyId: number;
  counterpartyName: string;
  counterpartyDate: DateStr;
  reason: string | null;
  status: string;
  createdAt: string;
}

export function listSwaps(userIds: number[]): SwapRequest[] {
  if (userIds.length === 0) return [];
  const ids = placeholders(userIds.length);
  return (
    db
      .prepare(
        `SELECT s.*, r.name AS requester_name, c.name AS counterparty_name
         FROM shift_swaps s
         JOIN users r ON r.id = s.requester_id
         JOIN users c ON c.id = s.counterparty_id
         WHERE s.requester_id IN (${ids}) OR s.counterparty_id IN (${ids})
         ORDER BY s.created_at DESC LIMIT 100`,
      )
      .all(...userIds, ...userIds) as any[]
  ).map((r) => ({
    id: r.id,
    requesterId: r.requester_id,
    requesterName: r.requester_name,
    requesterDate: r.requester_date,
    counterpartyId: r.counterparty_id,
    counterpartyName: r.counterparty_name,
    counterpartyDate: r.counterparty_date,
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
  }));
}

export function requestSwap(params: {
  requesterId: number;
  requesterDate: DateStr;
  counterpartyId: number;
  counterpartyDate: DateStr;
  reason?: string;
}): { ok: boolean; message: string; id?: number } {
  const { requesterId, requesterDate, counterpartyId, counterpartyDate } = params;

  if (requesterId === counterpartyId) {
    return { ok: false, message: 'You cannot swap a shift with yourself.' };
  }
  if (getShifts(requesterId, requesterDate).length === 0) {
    return { ok: false, message: `You have no shift on ${requesterDate} to give away.` };
  }
  if (getShifts(counterpartyId, counterpartyDate).length === 0) {
    return { ok: false, message: `They have no shift on ${counterpartyDate} to take.` };
  }
  // Nobody can be in two places at once.
  if (requesterDate !== counterpartyDate) {
    if (getShifts(requesterId, counterpartyDate).length > 0) {
      return { ok: false, message: `You are already scheduled on ${counterpartyDate}.` };
    }
    if (getShifts(counterpartyId, requesterDate).length > 0) {
      return { ok: false, message: `They are already scheduled on ${requesterDate}.` };
    }
  }

  const info = db
    .prepare(
      `INSERT INTO shift_swaps (requester_id, requester_date, counterparty_id, counterparty_date, reason)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(requesterId, requesterDate, counterpartyId, counterpartyDate, params.reason ?? null);

  // The counterparty is the only person who can move this forward, so they are
  // the only person told about it at this stage.
  const requester = nameOf(requesterId);
  notify(
    [counterpartyId],
    'Shift swap requested',
    `${requester} would like your ${counterpartyDate} shift and offers theirs on ${requesterDate}.` +
      (params.reason ? ` Reason: ${params.reason}` : ''),
  );
  emit('swap.changed', counterpartyId, `${requester} asked ${nameOf(counterpartyId)} for a shift swap`, {
    swapId: Number(info.lastInsertRowid),
    status: 'PENDING_PEER',
  });

  return {
    ok: true,
    id: Number(info.lastInsertRowid),
    message: 'Swap requested. It needs the other advisor to accept, then a supervisor to approve.',
  };
}

/** The other advisor accepting or refusing. */
export function respondToSwap(
  id: number,
  userId: number,
  accept: boolean,
): { ok: boolean; message: string } {
  const swap = db.prepare('SELECT * FROM shift_swaps WHERE id = ?').get(id) as any;
  if (!swap) return { ok: false, message: 'No such swap.' };
  if (swap.counterparty_id !== userId) return { ok: false, message: 'That swap is not addressed to you.' };
  if (swap.status !== 'PENDING_PEER') return { ok: false, message: `This swap is already ${swap.status}.` };

  db.prepare('UPDATE shift_swaps SET status = ? WHERE id = ?').run(
    accept ? 'PENDING_APPROVAL' : 'DECLINED',
    id,
  );

  const responder = nameOf(userId);
  const requester = nameOf(swap.requester_id);
  if (accept) {
    // The queue moves to the supervisors: tell whoever can now act on it.
    const approvers = [...new Set([...supervisorsOf(swap.requester_id), ...supervisorsOf(userId)])];
    notify(
      approvers,
      'Shift swap needs approval',
      `${requester} and ${responder} have agreed to swap ${swap.requester_date} for ${swap.counterparty_date}.`,
    );
    notify([swap.requester_id], 'Swap accepted', `${responder} accepted. It is now with your supervisor.`);
  } else {
    notify([swap.requester_id], 'Swap declined', `${responder} declined the swap you asked for.`, 'WARN');
  }
  emit('swap.changed', swap.requester_id, `${responder} ${accept ? 'accepted' : 'declined'} a swap with ${requester}`, {
    swapId: id,
    status: accept ? 'PENDING_APPROVAL' : 'DECLINED',
  });

  return {
    ok: true,
    message: accept ? 'Accepted. It now needs supervisor approval.' : 'Swap declined.',
  };
}

/**
 * Supervisor approval, which is the point the schedules actually move. The two
 * shifts are exchanged wholesale and both timecards re-derived, so the change
 * shows up everywhere a schedule matters rather than living in this table.
 */
export function decideSwap(
  id: number,
  actorId: number,
  approve: boolean,
): { ok: boolean; message: string } {
  const swap = db.prepare('SELECT * FROM shift_swaps WHERE id = ?').get(id) as any;
  if (!swap) return { ok: false, message: 'No such swap.' };
  if (swap.status !== 'PENDING_APPROVAL') {
    return { ok: false, message: `This swap is ${swap.status} and cannot be decided.` };
  }

  if (!approve) {
    db.prepare(
      "UPDATE shift_swaps SET status = 'DECLINED', decided_by = ?, decided_at = datetime('now') WHERE id = ?",
    ).run(actorId, id);
    notify(
      [swap.requester_id, swap.counterparty_id],
      'Swap not approved',
      `${nameOf(actorId)} did not approve the ${swap.requester_date} / ${swap.counterparty_date} swap. Both schedules are unchanged.`,
      'WARN',
    );
    emit('swap.changed', swap.requester_id, `${nameOf(actorId)} declined a shift swap`, {
      swapId: id,
      status: 'DECLINED',
    });
    return { ok: true, message: 'Swap declined.' };
  }

  const requesterShifts = getShifts(swap.requester_id, swap.requester_date);
  const counterpartyShifts = getShifts(swap.counterparty_id, swap.counterparty_date);
  if (requesterShifts.length === 0 || counterpartyShifts.length === 0) {
    return { ok: false, message: 'One of the shifts has changed since the swap was raised.' };
  }

  transact(() => {
    // Re-date each shift onto the other person's day before it moves across.
    saveShifts({
      userId: swap.counterparty_id,
      date: swap.requester_date,
      shifts: rebase(requesterShifts, swap.requester_date),
      actorId,
      source: 'SWAP',
    });
    saveShifts({
      userId: swap.requester_id,
      date: swap.counterparty_date,
      shifts: rebase(counterpartyShifts, swap.counterparty_date),
      actorId,
      source: 'SWAP',
    });

    if (swap.requester_date !== swap.counterparty_date) {
      db.prepare('DELETE FROM schedules WHERE user_id = ? AND payroll_date = ?').run(
        swap.requester_id,
        swap.requester_date,
      );
      db.prepare('DELETE FROM schedules WHERE user_id = ? AND payroll_date = ?').run(
        swap.counterparty_id,
        swap.counterparty_date,
      );
    }

    db.prepare(
      "UPDATE shift_swaps SET status = 'APPROVED', decided_by = ?, decided_at = datetime('now') WHERE id = ?",
    ).run(actorId, id);
    audit(actorId, 'swap', id, 'APPROVE', swap);
  });

  for (const [userId, date] of [
    [swap.requester_id, swap.counterparty_date],
    [swap.counterparty_id, swap.requester_date],
  ] as [number, string][]) {
    generateTimecard({ userId, date, actorId, force: true });
  }

  // Both advisors now work a different day from the one they planned for, which
  // is the kind of thing worth being told twice.
  notify(
    [swap.requester_id],
    'Swap approved',
    `Your ${swap.requester_date} shift has moved to ${swap.counterparty_date}.`,
  );
  notify(
    [swap.counterparty_id],
    'Swap approved',
    `Your ${swap.counterparty_date} shift has moved to ${swap.requester_date}.`,
  );
  emit(
    'swap.changed',
    swap.requester_id,
    `${nameOf(swap.requester_id)} and ${nameOf(swap.counterparty_id)} swapped shifts`,
    { swapId: id, status: 'APPROVED' },
  );
  emit('schedule.changed', swap.counterparty_id, `${nameOf(swap.counterparty_id)}'s schedule changed by swap`, {
    date: swap.requester_date,
  });

  return { ok: true, message: 'Swap approved and both schedules updated.' };
}

function rebase(shifts: ReturnType<typeof getShifts>, date: DateStr) {
  return shifts.map((shift) => ({
    ...shift,
    rows: shift.rows.map((row) => ({ ...row, startAt: `${date} ${row.startAt.slice(11)}` })),
    endAt: `${row0Date(shift.endAt, date)} ${shift.endAt.slice(11)}`,
  }));
}

/** Keep an overnight shift's end on the following day when it is re-dated. */
function row0Date(endAt: string, date: DateStr): string {
  return endAt.slice(11) < '12:00' ? addDays(date, 1) : date;
}

// ------------------------------------------------------------- extra hours

export function listOffers(projectId: string | null, userId: number) {
  const offers = db
    .prepare(
      `SELECT o.*, u.name AS created_by_name,
              (SELECT COUNT(*) FROM extra_hours_bids b WHERE b.offer_id = o.id) AS bid_count,
              (SELECT status FROM extra_hours_bids b WHERE b.offer_id = o.id AND b.user_id = ?) AS my_bid
       FROM extra_hours_offers o JOIN users u ON u.id = o.created_by
       WHERE (? IS NULL OR o.project_id = ?)
       ORDER BY o.date DESC, o.start_time LIMIT 100`,
    )
    .all(userId, projectId, projectId) as any[];
  return offers;
}

export function createOffer(params: {
  projectId: string;
  date: DateStr;
  startTime: string;
  endTime: string;
  slots: number;
  note?: string;
  actorId: number;
}): { ok: boolean; id: number } {
  const info = db
    .prepare(
      `INSERT INTO extra_hours_offers (project_id, date, start_time, end_time, slots, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.projectId,
      params.date,
      params.startTime,
      params.endTime,
      Math.max(1, params.slots),
      params.note ?? null,
      params.actorId,
    );
  audit(params.actorId, 'extra_hours', Number(info.lastInsertRowid), 'OFFER', params);

  // An offer nobody hears about is not an offer. Everyone on the project who
  // could work it is told, once.
  const advisors = (
    db
      .prepare("SELECT id FROM users WHERE project_id = ? AND role = 'ADVISOR' AND status = 'ACTIVE'")
      .all(params.projectId) as { id: number }[]
  ).map((r) => r.id);
  notify(
    advisors,
    'Extra hours available',
    `${params.startTime}–${params.endTime} on ${params.date}, ${params.slots} slot${params.slots === 1 ? '' : 's'}.` +
      (params.note ? ` ${params.note.replace(/\.?$/, '.')}` : '') +
      ' Bid under My Shifts → Extra Hours.',
  );
  for (const advisorId of advisors) {
    emit('extra-hours.changed', advisorId, `Extra hours offered on ${params.date}`, {
      offerId: Number(info.lastInsertRowid),
      date: params.date,
    });
  }

  return { ok: true, id: Number(info.lastInsertRowid) };
}

export function placeBid(offerId: number, userId: number): { ok: boolean; message: string } {
  const offer = db.prepare('SELECT * FROM extra_hours_offers WHERE id = ?').get(offerId) as any;
  if (!offer) return { ok: false, message: 'No such offer.' };
  if (offer.status !== 'OPEN') return { ok: false, message: 'That offer is closed.' };

  try {
    db.prepare('INSERT INTO extra_hours_bids (offer_id, user_id) VALUES (?, ?)').run(offerId, userId);
  } catch {
    return { ok: false, message: 'You have already bid for this one.' };
  }
  emit('extra-hours.changed', userId, `${nameOf(userId)} bid for extra hours on ${offer.date}`, {
    offerId,
    date: offer.date,
  });
  return { ok: true, message: 'Bid placed. You will be told if it is awarded.' };
}

/**
 * Awarding a bid adds the extra hours as a second shift, which is what makes
 * the advisor able to clock on for it — the clock only opens inside a schedule.
 */
export function awardBid(bidId: number, actorId: number): { ok: boolean; message: string } {
  const bid = db
    .prepare(
      `SELECT b.*, o.date, o.start_time, o.end_time, o.slots, o.id AS offer_id
       FROM extra_hours_bids b JOIN extra_hours_offers o ON o.id = b.offer_id WHERE b.id = ?`,
    )
    .get(bidId) as any;
  if (!bid) return { ok: false, message: 'No such bid.' };

  const awarded = db
    .prepare("SELECT COUNT(*) AS n FROM extra_hours_bids WHERE offer_id = ? AND status = 'AWARDED'")
    .get(bid.offer_id) as { n: number };
  if (awarded.n >= bid.slots) return { ok: false, message: 'Every slot on this offer is taken.' };

  const existing = getShifts(bid.user_id, bid.date);
  const shiftNo = Math.max(0, ...existing.map((s) => s.shiftNo)) + 1;
  const endsNextDay = bid.end_time < bid.start_time;

  const result = saveShifts({
    userId: bid.user_id,
    date: bid.date,
    shifts: [
      ...existing,
      {
        shiftNo,
        rows: [{ startAt: `${bid.date} ${bid.start_time}`, activityKey: 'EXTRA_HOURS' as const }],
        endAt: `${endsNextDay ? addDays(bid.date, 1) : bid.date} ${bid.end_time}`,
      },
    ],
    actorId,
    source: 'EXTRA_HOURS',
  });

  if (!result.ok) {
    return {
      ok: false,
      message: result.issues.find((i) => i.level === 'error')?.message ?? 'Could not add the shift.',
    };
  }

  db.prepare("UPDATE extra_hours_bids SET status = 'AWARDED' WHERE id = ?").run(bidId);
  if (awarded.n + 1 >= bid.slots) {
    db.prepare("UPDATE extra_hours_offers SET status = 'FILLED' WHERE id = ?").run(bid.offer_id);
  }
  audit(actorId, 'extra_hours', bid.offer_id, 'AWARD', { userId: bid.user_id, date: bid.date });
  generateTimecard({ userId: bid.user_id, date: bid.date, actorId });

  notify(
    [bid.user_id],
    'Extra hours awarded',
    `You have ${bid.start_time}–${bid.end_time} on ${bid.date}. It is on your schedule, so you can clock on for it.`,
  );
  emit('extra-hours.changed', bid.user_id, `${nameOf(bid.user_id)} was awarded extra hours on ${bid.date}`, {
    offerId: bid.offer_id,
    date: bid.date,
  });
  emit('schedule.changed', bid.user_id, `${nameOf(bid.user_id)}'s schedule gained extra hours`, {
    date: bid.date,
  });

  return { ok: true, message: 'Awarded. The extra hours are on their schedule and they can clock on.' };
}

export function listBids(offerId: number) {
  return db
    .prepare(
      `SELECT b.id, b.user_id, b.status, b.created_at, u.name, u.employee_id
       FROM extra_hours_bids b JOIN users u ON u.id = b.user_id
       WHERE b.offer_id = ? ORDER BY b.created_at`,
    )
    .all(offerId);
}
