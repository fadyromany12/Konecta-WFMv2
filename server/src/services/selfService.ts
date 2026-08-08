/**
 * Advisor self-service: swapping shifts and bidding for extra hours.
 *
 * Both flows move work off supervisors and onto the people whose time it is,
 * but neither bypasses them — a swap needs the other advisor *and* a
 * supervisor, and a bid still has to be awarded. The point is to remove the
 * chasing, not the control.
 */

import { audit, db, transact } from '../db/index.js';
import { addDays, nowStamp, type DateStr } from '../domain/time.js';
import type { ScheduleShift } from '../domain/schedule.js';
import { getShifts, saveShifts } from './scheduling.js';
import { placeholders } from './people.js';
import { generateTimecard } from './timecards.js';
import { emit, notify, supervisorsOf } from './events.js';

/** Name for a user id, for notification copy. Falls back to the id. */
async function nameOf(userId: number): Promise<string> {
  const row = await db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [userId]);
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

export async function listSwaps(userIds: number[]): Promise<SwapRequest[]> {
  if (userIds.length === 0) return [];
  const ids = placeholders(userIds.length);
  const rows = await db.all<any>(
    `SELECT s.*, r.name AS requester_name, c.name AS counterparty_name
     FROM shift_swaps s
     JOIN users r ON r.id = s.requester_id
     JOIN users c ON c.id = s.counterparty_id
     WHERE s.requester_id IN (${ids}) OR s.counterparty_id IN (${ids})
     ORDER BY s.created_at DESC LIMIT 100`,
    [...userIds, ...userIds],
  );
  return rows.map((r) => ({
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

export async function requestSwap(params: {
  requesterId: number;
  requesterDate: DateStr;
  counterpartyId: number;
  counterpartyDate: DateStr;
  reason?: string;
}): Promise<{ ok: boolean; message: string; id?: number }> {
  const { requesterId, requesterDate, counterpartyId, counterpartyDate } = params;

  if (requesterId === counterpartyId) {
    return { ok: false, message: 'You cannot swap a shift with yourself.' };
  }
  if ((await getShifts(requesterId, requesterDate)).length === 0) {
    return { ok: false, message: `You have no shift on ${requesterDate} to give away.` };
  }
  if ((await getShifts(counterpartyId, counterpartyDate)).length === 0) {
    return { ok: false, message: `They have no shift on ${counterpartyDate} to take.` };
  }
  // Nobody can be in two places at once.
  if (requesterDate !== counterpartyDate) {
    if ((await getShifts(requesterId, counterpartyDate)).length > 0) {
      return { ok: false, message: `You are already scheduled on ${counterpartyDate}.` };
    }
    if ((await getShifts(counterpartyId, requesterDate)).length > 0) {
      return { ok: false, message: `They are already scheduled on ${requesterDate}.` };
    }
  }

  const swapId = await db.insert(
    `INSERT INTO shift_swaps (requester_id, requester_date, counterparty_id, counterparty_date, reason)
     VALUES (?, ?, ?, ?, ?)`,
    [requesterId, requesterDate, counterpartyId, counterpartyDate, params.reason ?? null],
  );

  // The counterparty is the only person who can move this forward, so they are
  // the only person told about it at this stage.
  const requester = await nameOf(requesterId);
  await notify(
    [counterpartyId],
    'Shift swap requested',
    `${requester} would like your ${counterpartyDate} shift and offers theirs on ${requesterDate}.` +
      (params.reason ? ` Reason: ${params.reason}` : ''),
  );
  emit('swap.changed', counterpartyId, `${requester} asked ${await nameOf(counterpartyId)} for a shift swap`, {
    swapId,
    status: 'PENDING_PEER',
  });

  return {
    ok: true,
    id: swapId,
    message: 'Swap requested. It needs the other advisor to accept, then a supervisor to approve.',
  };
}

/** The other advisor accepting or refusing. */
export async function respondToSwap(
  id: number,
  userId: number,
  accept: boolean,
): Promise<{ ok: boolean; message: string }> {
  const swap = await db.get<any>('SELECT * FROM shift_swaps WHERE id = ?', [id]);
  if (!swap) return { ok: false, message: 'No such swap.' };
  if (swap.counterparty_id !== userId) return { ok: false, message: 'That swap is not addressed to you.' };
  if (swap.status !== 'PENDING_PEER') return { ok: false, message: `This swap is already ${swap.status}.` };

  await db.run('UPDATE shift_swaps SET status = ? WHERE id = ?', [
    accept ? 'PENDING_APPROVAL' : 'DECLINED',
    id,
  ]);

  const responder = await nameOf(userId);
  const requester = await nameOf(swap.requester_id);
  if (accept) {
    // The queue moves to the supervisors: tell whoever can now act on it.
    const approvers = [
      ...new Set([...(await supervisorsOf(swap.requester_id)), ...(await supervisorsOf(userId))]),
    ];
    await notify(
      approvers,
      'Shift swap needs approval',
      `${requester} and ${responder} have agreed to swap ${swap.requester_date} for ${swap.counterparty_date}.`,
    );
    await notify(
      [swap.requester_id],
      'Swap accepted',
      `${responder} accepted. It is now with your supervisor.`,
    );
  } else {
    await notify(
      [swap.requester_id],
      'Swap declined',
      `${responder} declined the swap you asked for.`,
      'WARN',
    );
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
export async function decideSwap(
  id: number,
  actorId: number,
  approve: boolean,
): Promise<{ ok: boolean; message: string }> {
  const swap = await db.get<any>('SELECT * FROM shift_swaps WHERE id = ?', [id]);
  if (!swap) return { ok: false, message: 'No such swap.' };
  if (swap.status !== 'PENDING_APPROVAL') {
    return { ok: false, message: `This swap is ${swap.status} and cannot be decided.` };
  }

  if (!approve) {
    await db.run('UPDATE shift_swaps SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', [
      'DECLINED',
      actorId,
      nowStamp(),
      id,
    ]);
    const decider = await nameOf(actorId);
    await notify(
      [swap.requester_id, swap.counterparty_id],
      'Swap not approved',
      `${decider} did not approve the ${swap.requester_date} / ${swap.counterparty_date} swap. Both schedules are unchanged.`,
      'WARN',
    );
    emit('swap.changed', swap.requester_id, `${decider} declined a shift swap`, {
      swapId: id,
      status: 'DECLINED',
    });
    return { ok: true, message: 'Swap declined.' };
  }

  const requesterShifts = await getShifts(swap.requester_id, swap.requester_date);
  const counterpartyShifts = await getShifts(swap.counterparty_id, swap.counterparty_date);
  if (requesterShifts.length === 0 || counterpartyShifts.length === 0) {
    return { ok: false, message: 'One of the shifts has changed since the swap was raised.' };
  }

  await transact(async () => {
    // Re-date each shift onto the other person's day before it moves across.
    await saveShifts({
      userId: swap.counterparty_id,
      date: swap.requester_date,
      shifts: rebase(requesterShifts, swap.requester_date),
      actorId,
      source: 'SWAP',
    });
    await saveShifts({
      userId: swap.requester_id,
      date: swap.counterparty_date,
      shifts: rebase(counterpartyShifts, swap.counterparty_date),
      actorId,
      source: 'SWAP',
    });

    if (swap.requester_date !== swap.counterparty_date) {
      await db.run('DELETE FROM schedules WHERE user_id = ? AND payroll_date = ?', [
        swap.requester_id,
        swap.requester_date,
      ]);
      await db.run('DELETE FROM schedules WHERE user_id = ? AND payroll_date = ?', [
        swap.counterparty_id,
        swap.counterparty_date,
      ]);
    }

    await db.run('UPDATE shift_swaps SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', [
      'APPROVED',
      actorId,
      nowStamp(),
      id,
    ]);
    await audit(actorId, 'swap', id, 'APPROVE', swap);
  });

  for (const [userId, date] of [
    [swap.requester_id, swap.counterparty_date],
    [swap.counterparty_id, swap.requester_date],
  ] as [number, string][]) {
    await generateTimecard({ userId, date, actorId, force: true });
  }

  // Both advisors now work a different day from the one they planned for, which
  // is the kind of thing worth being told twice.
  await notify(
    [swap.requester_id],
    'Swap approved',
    `Your ${swap.requester_date} shift has moved to ${swap.counterparty_date}.`,
  );
  await notify(
    [swap.counterparty_id],
    'Swap approved',
    `Your ${swap.counterparty_date} shift has moved to ${swap.requester_date}.`,
  );
  const [requesterName, counterpartyName] = await Promise.all([
    nameOf(swap.requester_id),
    nameOf(swap.counterparty_id),
  ]);
  emit('swap.changed', swap.requester_id, `${requesterName} and ${counterpartyName} swapped shifts`, {
    swapId: id,
    status: 'APPROVED',
  });
  emit('schedule.changed', swap.counterparty_id, `${counterpartyName}'s schedule changed by swap`, {
    date: swap.requester_date,
  });

  return { ok: true, message: 'Swap approved and both schedules updated.' };
}

function rebase(shifts: ScheduleShift[], date: DateStr) {
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
  // The project filter is applied by branching rather than with `? IS NULL`.
  // Postgres has nothing to infer a parameter's type from in that expression and
  // rejects the statement outright — a difference SQLite hides, because it does
  // not care about parameter types at all.
  const base = `SELECT o.*, u.name AS created_by_name,
            (SELECT COUNT(*) FROM extra_hours_bids b WHERE b.offer_id = o.id) AS bid_count,
            (SELECT status FROM extra_hours_bids b WHERE b.offer_id = o.id AND b.user_id = ?) AS my_bid
     FROM extra_hours_offers o JOIN users u ON u.id = o.created_by`;
  const tail = 'ORDER BY o.date DESC, o.start_time, o.id LIMIT 100';

  return projectId === null
    ? db.all<any>(`${base} ${tail}`, [userId])
    : db.all<any>(`${base} WHERE o.project_id = ? ${tail}`, [userId, projectId]);
}

export async function createOffer(params: {
  projectId: string;
  date: DateStr;
  startTime: string;
  endTime: string;
  slots: number;
  note?: string;
  actorId: number;
}): Promise<{ ok: boolean; id: number }> {
  const offerId = await db.insert(
    `INSERT INTO extra_hours_offers (project_id, date, start_time, end_time, slots, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      params.projectId,
      params.date,
      params.startTime,
      params.endTime,
      Math.max(1, params.slots),
      params.note ?? null,
      params.actorId,
    ],
  );
  await audit(params.actorId, 'extra_hours', offerId, 'OFFER', params);

  // An offer nobody hears about is not an offer. Everyone on the project who
  // could work it is told, once.
  const rows = await db.all<{ id: number }>(
    "SELECT id FROM users WHERE project_id = ? AND role = 'ADVISOR' AND status = 'ACTIVE'",
    [params.projectId],
  );
  const advisors = rows.map((r) => r.id);
  await notify(
    advisors,
    'Extra hours available',
    `${params.startTime}–${params.endTime} on ${params.date}, ${params.slots} slot${params.slots === 1 ? '' : 's'}.` +
      (params.note ? ` ${params.note.replace(/\.?$/, '.')}` : '') +
      ' Bid under My Shifts → Extra Hours.',
  );
  for (const advisorId of advisors) {
    emit('extra-hours.changed', advisorId, `Extra hours offered on ${params.date}`, {
      offerId,
      date: params.date,
    });
  }

  return { ok: true, id: offerId };
}

export async function placeBid(offerId: number, userId: number): Promise<{ ok: boolean; message: string }> {
  const offer = await db.get<any>('SELECT * FROM extra_hours_offers WHERE id = ?', [offerId]);
  if (!offer) return { ok: false, message: 'No such offer.' };
  if (offer.status !== 'OPEN') return { ok: false, message: 'That offer is closed.' };

  try {
    await db.run('INSERT INTO extra_hours_bids (offer_id, user_id) VALUES (?, ?)', [offerId, userId]);
  } catch {
    // The unique constraint on (offer_id, user_id) is what makes a second bid
    // impossible; catching it is cheaper and more correct than checking first.
    return { ok: false, message: 'You have already bid for this one.' };
  }
  emit('extra-hours.changed', userId, `${await nameOf(userId)} bid for extra hours on ${offer.date}`, {
    offerId,
    date: offer.date,
  });
  return { ok: true, message: 'Bid placed. You will be told if it is awarded.' };
}

/**
 * Awarding a bid adds the extra hours as a second shift, which is what makes
 * the advisor able to clock on for it — the clock only opens inside a schedule.
 */
export async function awardBid(bidId: number, actorId: number): Promise<{ ok: boolean; message: string }> {
  const bid = await db.get<any>(
    `SELECT b.*, o.date, o.start_time, o.end_time, o.slots, o.id AS offer_id
     FROM extra_hours_bids b JOIN extra_hours_offers o ON o.id = b.offer_id WHERE b.id = ?`,
    [bidId],
  );
  if (!bid) return { ok: false, message: 'No such bid.' };

  const awarded = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM extra_hours_bids WHERE offer_id = ? AND status = 'AWARDED'",
    [bid.offer_id],
  );
  if ((awarded?.n ?? 0) >= bid.slots) return { ok: false, message: 'Every slot on this offer is taken.' };

  const existing = await getShifts(bid.user_id, bid.date);
  const shiftNo = Math.max(0, ...existing.map((s) => s.shiftNo)) + 1;
  const endsNextDay = bid.end_time < bid.start_time;

  const result = await saveShifts({
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

  await db.run('UPDATE extra_hours_bids SET status = ? WHERE id = ?', ['AWARDED', bidId]);
  if ((awarded?.n ?? 0) + 1 >= bid.slots) {
    await db.run('UPDATE extra_hours_offers SET status = ? WHERE id = ?', ['FILLED', bid.offer_id]);
  }
  await audit(actorId, 'extra_hours', bid.offer_id, 'AWARD', { userId: bid.user_id, date: bid.date });
  await generateTimecard({ userId: bid.user_id, date: bid.date, actorId });

  const advisorName = await nameOf(bid.user_id);
  await notify(
    [bid.user_id],
    'Extra hours awarded',
    `You have ${bid.start_time}–${bid.end_time} on ${bid.date}. It is on your schedule, so you can clock on for it.`,
  );
  emit('extra-hours.changed', bid.user_id, `${advisorName} was awarded extra hours on ${bid.date}`, {
    offerId: bid.offer_id,
    date: bid.date,
  });
  emit('schedule.changed', bid.user_id, `${advisorName}'s schedule gained extra hours`, {
    date: bid.date,
  });

  return { ok: true, message: 'Awarded. The extra hours are on their schedule and they can clock on.' };
}

export function listBids(offerId: number) {
  return db.all<any>(
    `SELECT b.id, b.user_id, b.status, b.created_at, u.name, u.employee_id
     FROM extra_hours_bids b JOIN users u ON u.id = b.user_id
     WHERE b.offer_id = ? ORDER BY b.created_at`,
    [offerId],
  );
}
