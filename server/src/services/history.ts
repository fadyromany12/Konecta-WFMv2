/**
 * What was done to somebody's record, told to them.
 *
 * The audit table has always recorded who changed what. It was readable only
 * by supervisors, on an admin screen, as raw rows — which means the person the
 * change was actually done *to* was the one person who could not see it.
 *
 * That asymmetry is the problem worth fixing. An advisor who finds their
 * Thursday has moved has no way to know whether it was moved, by whom, or when
 * — so the conversation starts with "I think my schedule changed" instead of
 * "you moved my Thursday on Tuesday afternoon". The data to answer it already
 * existed; nobody had turned it around to face the other way.
 *
 * Deliberately read-only and deliberately narrow: their own record only, and
 * only the actions that change something they are held to.
 */

import { db } from '../db/index.js';
import { todayStr, type DateStr } from '../domain/time.js';

export interface HistoryEntry {
  at: string;
  /** Who did it. Null for anything the system did to itself. */
  actor: string | null;
  /** The day being talked about, where the entry is about a particular day. */
  date: DateStr | null;
  /** One sentence, already written. */
  what: string;
  kind: 'schedule' | 'timecard' | 'approval';
}

interface AuditRow {
  at: string;
  actor_name: string | null;
  entity: string;
  entity_id: string;
  action: string;
  detail: string | null;
  payroll_date?: string | null;
}

/**
 * One person's history across a range.
 *
 * Two queries rather than a union, because the two halves are keyed
 * differently: schedule rows carry `userId:date` in the entity id, while
 * timecard rows carry the timecard's own id and have to be joined back.
 */
export async function historyFor(params: {
  userId: number;
  start: DateStr;
  end: DateStr;
}): Promise<HistoryEntry[]> {
  const { userId, start, end } = params;

  const [scheduleRows, timecardRows] = await Promise.all([
    db.all<AuditRow>(
      `SELECT a.at, a.entity, a.entity_id, a.action, a.detail, u.name AS actor_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.entity = 'schedule' AND a.entity_id LIKE ?
       ORDER BY a.id DESC LIMIT 200`,
      [`${userId}:%`],
    ),
    db.all<AuditRow>(
      `SELECT a.at, a.entity, a.entity_id, a.action, a.detail, u.name AS actor_name,
              t.payroll_date
       FROM audit_log a
       -- Cast the id to text rather than the entity id to a number. Postgres
       -- is free to evaluate the join before the entity filter, and casting
       -- '12:2026-08-08' to an integer is an error, not a non-match.
       JOIN timecards t ON CAST(t.id AS TEXT) = a.entity_id
       LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.entity = 'timecard' AND t.user_id = ?
         AND t.payroll_date BETWEEN ? AND ?
         AND a.action <> 'REBUILD'
       ORDER BY a.id DESC LIMIT 200`,
      [userId, start, end],
    ),
  ]);

  const entries: HistoryEntry[] = [];

  for (const row of scheduleRows) {
    const date = row.entity_id.slice(String(userId).length + 1) as DateStr;
    if (date < start || date > end) continue;
    entries.push({
      at: row.at,
      actor: row.actor_name,
      date,
      kind: 'schedule',
      what:
        row.action === 'PUBLISH'
          ? `Your ${date} schedule was published.`
          : `Your ${date} schedule was changed.`,
    });
  }

  for (const row of timecardRows) {
    const date = (row.payroll_date ?? null) as DateStr | null;
    entries.push({
      at: row.at,
      actor: row.actor_name,
      date,
      kind: row.action.startsWith('APPROVE') || row.action === 'UNAPPROVE' ? 'approval' : 'timecard',
      what: describeTimecard(row.action, date, row.detail),
    });
  }

  // Newest first across both halves. Sorted here rather than in SQL because
  // the two queries cannot be ordered against each other.
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 100);
}

function describeTimecard(action: string, date: DateStr | null, detail: string | null): string {
  const day = date ? ` for ${date}` : '';
  switch (action) {
    case 'APPROVE':
      return `Your timecard${day} was approved.`;
    case 'UNAPPROVE':
      return `Your timecard${day} was un-approved.`;
    case 'MANUAL_CHECK':
      return `Your timecard${day} was flagged for a manual check.`;
    case 'EDIT_POST_PAYROLL': {
      const reason = reasonFrom(detail);
      return `Your timecard${day} was corrected after payroll ran${reason ? `: ${reason}` : '.'}`;
    }
    case 'EDIT':
      return `Your timecard${day} was edited.`;
    default:
      return `Your timecard${day} changed (${action.toLowerCase()}).`;
  }
}

/** Post-payroll corrections carry a reason, and it is the whole point of them. */
function reasonFrom(detail: string | null): string | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail);
    return typeof parsed?.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : null;
  } catch {
    return null;
  }
}

export interface RuleChange {
  at: string;
  actor: string | null;
  /** What kind of rule moved. */
  kind: 'shift-rule' | 'forecast-settings' | 'payroll-run' | 'schedule-publish';
  /** One sentence, already written. */
  what: string;
  /** Who or what it applies to, where that is a person or a project. */
  subject: string | null;
  /** When it starts to bite, for changes that are dated forward. */
  effectiveDate: DateStr | null;
  /** True while an effective date is still in the future. */
  pending: boolean;
}

/**
 * Everything that changed the rules, in one list.
 *
 * The first question after a disputed payroll run is "what was different?",
 * and until now answering it meant three places: the shift-rule history on one
 * person's record, the forecast settings which showed only their current
 * value, and the raw audit table. None of them was a timeline, and the
 * forecast settings did not keep their old values at all.
 *
 * Deliberately not the whole audit log. Editing one timecard is not a rule
 * change; altering the service goal that every requirement is computed from
 * is. Mixing the two produces a list nobody reads.
 */
export async function rulesLog(params: { limit?: number } = {}): Promise<RuleChange[]> {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 300);
  const today = todayStr();

  const rows = await db.all<{
    at: string;
    actor_name: string | null;
    entity: string;
    entity_id: string;
    action: string;
    detail: string | null;
  }>(
    `SELECT a.at, a.entity, a.entity_id, a.action, a.detail, u.name AS actor_name
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     WHERE (a.entity = 'shift_rule')
        OR (a.entity = 'forecast' AND a.action = 'SETTINGS')
        OR (a.entity = 'payroll' AND a.action = 'RUN')
        OR (a.entity = 'schedule' AND a.action = 'PUBLISH' AND a.entity_id LIKE '%-%:%-%')
     ORDER BY a.id DESC LIMIT ?`,
    [limit],
  );

  return rows.map((row) => {
    const detail = parse(row.detail);
    switch (row.entity) {
      case 'shift_rule': {
        const effective = (detail?.effectiveDate as DateStr | undefined) ?? null;
        return {
          at: row.at,
          actor: row.actor_name,
          kind: 'shift-rule' as const,
          subject: (detail?.subject as string) ?? `#${row.entity_id}`,
          effectiveDate: effective,
          pending: effective !== null && effective > today,
          what: `Shift rule set to ${detail?.shiftRule ?? '?'}${effective ? `, from ${effective}` : ''}.`,
        };
      }
      case 'forecast':
        return {
          at: row.at,
          actor: row.actor_name,
          kind: 'forecast-settings' as const,
          subject: row.entity_id,
          effectiveDate: null,
          pending: false,
          what:
            `Staffing goal set to ${describePct(detail?.serviceGoal)} within ` +
            `${detail?.targetSeconds ?? '?'}s, shrinkage ${describePct(detail?.shrinkage)}. ` +
            'Every requirement computed after this used the new figures.',
        };
      case 'payroll': {
        // The period start is the second half of the entity id — `EMEA:2026-07-11`
        // — and is not repeated in the detail. Reading it from the detail gave
        // "Payroll run for ? to ...", which is exactly the sort of half-written
        // sentence that makes a log look untrustworthy.
        const [region, start] = row.entity_id.split(':');
        return {
          at: row.at,
          actor: row.actor_name,
          kind: 'payroll-run' as const,
          subject: region ?? null,
          effectiveDate: null,
          pending: false,
          what:
            `Payroll run for ${start ?? '?'} to ${detail?.end ?? '?'}` +
            (typeof detail?.cards === 'number' ? `, ${detail.cards} cards protected` : '') +
            '. Edits to those days are corrections from this point, and need a reason.',
        };
      }
      default:
        return {
          at: row.at,
          actor: row.actor_name,
          kind: 'schedule-publish' as const,
          subject: row.entity_id,
          effectiveDate: null,
          pending: false,
          what: `Schedules published for ${row.entity_id.replace(':', ' to ')}.`,
        };
    }
  });
}

function parse(detail: string | null): Record<string, unknown> | null {
  if (!detail) return null;
  try {
    const value = JSON.parse(detail);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function describePct(value: unknown): string {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : '?';
}
