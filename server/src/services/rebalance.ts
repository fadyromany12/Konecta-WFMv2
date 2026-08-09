/**
 * What to do about today, with names attached.
 *
 * `domain/rebalance.ts` decides what kind of action each gap needs. This works
 * out who could actually take it — which is a database question, and the one
 * that turns a suggestion into something a supervisor can press a button on.
 */

import { db, placeholders } from '../db/index.js';
import { MAX_WEEKLY_HOURS } from '../domain/workingTime.js';
import { recommend, type Recommendation } from '../domain/rebalance.js';
import { addDays, diffMinutes, type DateStr } from '../domain/time.js';
import { coverageFor } from './forecasting.js';

export interface Candidate {
  userId: number;
  name: string;
  employeeId: string;
  /** Hours already rostered in the week containing the date. */
  weekHours: number;
  /** Hours they could take before hitting the statutory weekly ceiling. */
  headroom: number;
}

export interface RebalancePlan {
  date: DateStr;
  projectId: string;
  recommendations: Recommendation[];
  candidates: Candidate[];
  summary: string;
}

/** Monday of the week containing a date, matching the working-time rules. */
function weekStart(date: DateStr): DateStr {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  // getUTCDay is 0 for Sunday; the working week starts Monday.
  return addDays(date, -((dow + 6) % 7));
}

/**
 * Who is off on this date and has room in their week.
 *
 * Three filters, all of them refusals rather than preferences:
 *
 * Not already rostered that day — offering extra hours to somebody already
 * working them is the single most obvious way to lose trust in a suggestion.
 *
 * Not on approved leave. Somebody's booked holiday is not spare capacity, and
 * a tool that offers it to them will be turned off.
 *
 * Under the weekly ceiling with enough room left to be worth asking. The
 * 48-hour limit is statutory, so this is a constraint and not a nicety, and
 * offering somebody two hours they legally cannot work wastes their time and
 * the supervisor's.
 */
export async function candidatesFor(params: {
  userIds: number[];
  date: DateStr;
  minHeadroom?: number;
}): Promise<Candidate[]> {
  if (params.userIds.length === 0) return [];
  const minHeadroom = params.minHeadroom ?? 2;
  const marks = placeholders(params.userIds.length);
  const start = weekStart(params.date);
  const end = addDays(start, 6);

  const [rosteredToday, weekShifts, onLeave, people] = await Promise.all([
    db.all<{ user_id: number }>(
      `SELECT DISTINCT user_id FROM schedules
       WHERE user_id IN (${marks}) AND payroll_date = ?`,
      [...params.userIds, params.date],
    ),
    db.all<{ user_id: number; payroll_date: string; end_at: string; first_start: string }>(
      `SELECT s.user_id, s.payroll_date, s.end_at, MIN(r.start_at) AS first_start
       FROM schedules s JOIN schedule_rows r ON r.schedule_id = s.id
       WHERE s.user_id IN (${marks}) AND s.payroll_date BETWEEN ? AND ?
       GROUP BY s.id, s.user_id, s.payroll_date, s.end_at`,
      [...params.userIds, start, end],
    ),
    db.all<{ user_id: number }>(
      `SELECT DISTINCT user_id FROM time_off_requests
       WHERE user_id IN (${marks}) AND status = 'APPROVED'
         AND ? BETWEEN start_date AND end_date`,
      [...params.userIds, params.date],
    ),
    db.all<{ id: number; name: string; employee_id: string }>(
      `SELECT id, name, employee_id FROM users
       WHERE id IN (${marks}) AND status = 'ACTIVE' AND role = 'ADVISOR'`,
      params.userIds,
    ),
  ]);

  const busy = new Set(rosteredToday.map((r) => r.user_id));
  const away = new Set(onLeave.map((r) => r.user_id));

  const minutesBy = new Map<number, number>();
  for (const shift of weekShifts) {
    if (!shift.first_start) continue;
    const minutes = diffMinutes(shift.first_start, shift.end_at);
    minutesBy.set(shift.user_id, (minutesBy.get(shift.user_id) ?? 0) + Math.max(0, minutes));
  }

  return people
    .filter((p) => !busy.has(p.id) && !away.has(p.id))
    .map((p) => {
      const weekHours = (minutesBy.get(p.id) ?? 0) / 60;
      return {
        userId: p.id,
        name: p.name,
        employeeId: p.employee_id,
        weekHours: Math.round(weekHours * 10) / 10,
        headroom: Math.round((MAX_WEEKLY_HOURS - weekHours) * 10) / 10,
      };
    })
    .filter((c) => c.headroom >= minHeadroom)
    // Most headroom first: spreading extra hours across the people with the
    // most room is what keeps anybody from being pushed at the ceiling.
    .sort((a, b) => b.headroom - a.headroom || a.name.localeCompare(b.name));
}

export async function rebalanceFor(params: {
  projectId: string;
  date: DateStr;
  userIds: number[];
}): Promise<RebalancePlan> {
  const [cover, candidates] = await Promise.all([
    coverageFor({ projectId: params.projectId, date: params.date, userIds: params.userIds }),
    candidatesFor({ userIds: params.userIds, date: params.date }),
  ]);

  const recommendations = recommend({
    coverage: cover.coverage,
    availableForExtraHours: candidates.length,
  });

  const free = recommendations.filter((r) => r.kind === 'MOVE_BREAKS').length;
  const buy = recommendations.filter((r) => r.kind === 'OFFER_EXTRA_HOURS').length;
  const stuck = recommendations.filter((r) => r.kind === 'UNFILLABLE').length;

  const summary =
    recommendations.length === 0
      ? 'The day is covered. Nothing to do.'
      : [
          `${recommendations.length} ${recommendations.length === 1 ? 'action' : 'actions'}`,
          free > 0 ? `${free} free` : null,
          buy > 0 ? `${buy} needing extra hours` : null,
          stuck > 0 ? `${stuck} that cannot be covered from this team` : null,
        ]
          .filter(Boolean)
          .join(', ') + '.';

  return { date: params.date, projectId: params.projectId, recommendations, candidates, summary };
}
