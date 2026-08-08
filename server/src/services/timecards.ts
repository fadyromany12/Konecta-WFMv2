/**
 * Timecard persistence, generation and approval.
 *
 * A card is generated from punches the first time it is looked at, and from
 * then on it belongs to whoever edits it — the punch engine will not overwrite
 * human work. Saving re-validates the whole card and refuses to persist one
 * that has gaps, overlaps or a payroll date that disagrees with its own paid
 * time.
 */

import { audit, db, transact } from '../db/index.js';
import type { Role } from '../domain/reference.js';
import { evaluateEdit, type EditDecision } from '../domain/editWindow.js';
import { buildTimecard, type Punch } from '../domain/punchEngine.js';
import {
  exceptionCodes,
  mergeContiguous,
  payrollShiftDetail,
  sortRows,
  summarize,
  validateTimecard,
  type Issue,
  type TimecardRow,
} from '../domain/timecard.js';
import { addDays, nowStamp, todayStr, type DateStr } from '../domain/time.js';
import { effectiveShiftRule, getUser } from './people.js';
import { getShifts } from './scheduling.js';
import { emit, notify } from './events.js';

export interface TimecardRecord {
  id: number;
  user_id: number;
  payroll_date: string;
  shift_no: number;
  approved: number;
  approved_by: number | null;
  approved_at: string | null;
  protect_date: string | null;
  manual_check_status: string;
  assumed_off: number;
  in_progress: number;
  edited: number;
  notes: string | null;
}

export interface TimecardView {
  id: number;
  userId: number;
  userName: string;
  employeeId: string;
  payrollDate: DateStr;
  shiftNo: number;
  rows: TimecardRow[];
  summary: ReturnType<typeof summarize>;
  detail: ReturnType<typeof payrollShiftDetail>;
  approved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  protectDate: string | null;
  manualCheckStatus: string;
  assumedOff: boolean;
  inProgress: boolean;
  edited: boolean;
  exceptions: string[];
  notes: string[];
  issues: Issue[];
}

function readRows(timecardId: number): TimecardRow[] {
  return (
    db
      .prepare('SELECT id, code, project, activity, start_at, end_at FROM timecard_rows WHERE timecard_id = ? ORDER BY sort_order')
      .all(timecardId) as any[]
  ).map((r) => ({
    id: r.id,
    code: r.code,
    project: r.project,
    activity: r.activity,
    startAt: r.start_at,
    endAt: r.end_at,
  }));
}

function writeRows(timecardId: number, rows: TimecardRow[]): void {
  db.prepare('DELETE FROM timecard_rows WHERE timecard_id = ?').run(timecardId);
  const insert = db.prepare(
    'INSERT INTO timecard_rows (timecard_id, code, project, activity, start_at, end_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const [i, row] of rows.entries()) {
    insert.run(timecardId, row.code, row.project, row.activity, row.startAt, row.endAt, i);
  }
}

function getPunches(userId: number, date: DateStr): Punch[] {
  // A shift is anchored to its payroll date but its punches can spill into the
  // following calendar day, so the window deliberately runs past midnight.
  const from = `${date} 00:00`;
  const to = `${addDays(date, 1)} 23:59`;
  return (
    db
      .prepare('SELECT at, type, activity FROM punches WHERE user_id = ? AND at BETWEEN ? AND ? ORDER BY at')
      .all(userId, from, to) as any[]
  ).map((p) => ({ at: p.at, type: p.type, activity: p.activity }));
}

/**
 * Punches belonging to a payroll date: everything from the scheduled shift
 * start until the shift ends, rather than a naive calendar day.
 */
function punchesForShift(userId: number, date: DateStr): Punch[] {
  const shifts = getShifts(userId, date);
  const all = getPunches(userId, date);
  if (shifts.length === 0) return all.filter((p) => p.at.slice(0, 10) === date);
  const earliest = shifts.map((s) => s.rows[0]?.startAt ?? s.endAt).sort()[0];
  const latest = shifts.map((s) => s.endAt).sort().reverse()[0];
  const windowStart = `${date} 00:00` < earliest ? earliest : `${date} 00:00`;
  return all.filter((p) => p.at >= subtractHours(windowStart, 2) && p.at <= addHours(latest, 3));
}

function subtractHours(s: string, hours: number): string {
  const d = new Date(`${s.replace(' ', 'T')}:00Z`);
  d.setUTCHours(d.getUTCHours() - hours);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function addHours(s: string, hours: number): string {
  const d = new Date(`${s.replace(' ', 'T')}:00Z`);
  d.setUTCHours(d.getUTCHours() + hours);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function getTimecardRecord(userId: number, date: DateStr, shiftNo = 1): TimecardRecord | undefined {
  return db
    .prepare('SELECT * FROM timecards WHERE user_id = ? AND payroll_date = ? AND shift_no = ?')
    .get(userId, date, shiftNo) as TimecardRecord | undefined;
}

/**
 * Generate or refresh a card from punches. Cards a human has edited are left
 * alone unless `force` is set, which is what the explicit Rebuild action does.
 */
export function generateTimecard(params: {
  userId: number;
  date: DateStr;
  actorId: number | null;
  force?: boolean;
  now?: string;
}): TimecardRecord | undefined {
  const { userId, date, actorId, force = false } = params;
  const now = params.now ?? nowStamp();
  const existing = getTimecardRecord(userId, date);
  if (existing && existing.edited && !force) return existing;
  if (existing && existing.approved && !force) return existing;

  const user = getUser(userId);
  if (!user) return existing;

  const shifts = getShifts(userId, date);
  const punches = punchesForShift(userId, date);
  if (shifts.length === 0 && punches.length === 0) return existing;

  const built = buildTimecard({
    shifts,
    punches,
    rule: effectiveShiftRule(userId, date),
    project: user.project_id ?? '',
    now,
  });

  if (built.rows.length === 0 && !existing) return undefined;

  return transact(() => {
    let id = existing?.id;
    if (id === undefined) {
      const info = db
        .prepare(
          'INSERT INTO timecards (user_id, payroll_date, shift_no, assumed_off, in_progress, notes) VALUES (?, ?, 1, ?, ?, ?)',
        )
        .run(userId, date, built.assumedOff ? 1 : 0, built.inProgress ? 1 : 0, JSON.stringify(built.notes));
      id = Number(info.lastInsertRowid);
    } else {
      db.prepare(
        "UPDATE timecards SET assumed_off = ?, in_progress = ?, notes = ?, edited = 0, updated_at = datetime('now') WHERE id = ?",
      ).run(built.assumedOff ? 1 : 0, built.inProgress ? 1 : 0, JSON.stringify(built.notes), id);
    }
    writeRows(id, built.rows);
    if (force) audit(actorId, 'timecard', id, 'REBUILD', { rows: built.rows.length });
    return getTimecardRecord(userId, date);
  });
}

export function viewTimecard(params: {
  userId: number;
  date: DateStr;
  shiftNo?: number;
  autoGenerate?: boolean;
  actorId?: number | null;
}): TimecardView | null {
  const { userId, date, shiftNo = 1, autoGenerate = true, actorId = null } = params;
  if (autoGenerate) generateTimecard({ userId, date, actorId });

  const record = getTimecardRecord(userId, date, shiftNo);
  if (!record) return null;

  const user = getUser(userId);
  const rows = readRows(record.id);
  const approver = record.approved_by ? getUser(record.approved_by) : null;

  return {
    id: record.id,
    userId,
    userName: user?.name ?? '',
    employeeId: user?.employee_id ?? '',
    payrollDate: record.payroll_date,
    shiftNo: record.shift_no,
    rows,
    summary: summarize(rows),
    detail: payrollShiftDetail(rows),
    approved: !!record.approved,
    approvedBy: approver?.name ?? null,
    approvedAt: record.approved_at,
    protectDate: record.protect_date,
    manualCheckStatus: record.manual_check_status,
    assumedOff: !!record.assumed_off,
    inProgress: !!record.in_progress,
    edited: !!record.edited,
    exceptions: exceptionCodes(rows),
    notes: safeParse(record.notes),
    issues: validateTimecard(rows, record.payroll_date),
  };
}

function safeParse(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface SaveTimecardResult {
  ok: boolean;
  issues: Issue[];
  decision: EditDecision;
  timecard: TimecardView | null;
}

export function saveTimecard(params: {
  userId: number;
  date: DateStr;
  rows: TimecardRow[];
  actorId: number;
  actorRole: Role;
  today?: DateStr;
}): SaveTimecardResult {
  const { userId, date, actorId, actorRole } = params;
  const today = params.today ?? todayStr();
  const record = getTimecardRecord(userId, date);

  const decision = evaluateEdit({
    role: actorRole,
    payrollDate: date,
    today,
    protectDate: record?.protect_date ?? null,
  });

  if (!decision.allowed) {
    return { ok: false, issues: [{ level: 'error', message: decision.reason }], decision, timecard: null };
  }

  if (record?.approved) {
    return {
      ok: false,
      issues: [
        {
          level: 'error',
          message: 'This timecard is approved. Remove the approval before editing it.',
        },
      ],
      decision,
      timecard: viewTimecard({ userId, date, autoGenerate: false }),
    };
  }

  const rows = mergeContiguous(sortRows(params.rows));
  const issues = validateTimecard(rows, date);
  if (issues.some((i) => i.level === 'error')) {
    return { ok: false, issues, decision, timecard: null };
  }

  transact(() => {
    let id = record?.id;
    if (id === undefined) {
      const info = db
        .prepare('INSERT INTO timecards (user_id, payroll_date, shift_no, edited) VALUES (?, ?, 1, 1)')
        .run(userId, date);
      id = Number(info.lastInsertRowid);
    } else {
      db.prepare("UPDATE timecards SET edited = 1, updated_at = datetime('now') WHERE id = ?").run(id);
    }
    const before = record ? readRows(record.id) : [];
    writeRows(id, rows);
    audit(actorId, 'timecard', id, decision.postPayroll ? 'EDIT_POST_PAYROLL' : 'EDIT', {
      payrollDate: date,
      before,
      after: rows,
    });
  });

  return {
    ok: true,
    issues,
    decision,
    timecard: viewTimecard({ userId, date, autoGenerate: false }),
  };
}

export function setApproval(params: {
  userId: number;
  date: DateStr;
  approved: boolean;
  actorId: number;
  actorRole: Role;
  today?: DateStr;
}): { ok: boolean; message: string; timecard: TimecardView | null } {
  const { userId, date, approved, actorId } = params;
  const record = getTimecardRecord(userId, date);
  if (!record) return { ok: false, message: 'No timecard for that date.', timecard: null };

  if (record.in_progress && approved) {
    return {
      ok: false,
      message: 'The shift is still in progress. Approve once the advisor has clocked off.',
      timecard: viewTimecard({ userId, date, autoGenerate: false }),
    };
  }

  const rows = readRows(record.id);
  const issues = validateTimecard(rows, date);
  if (approved && issues.some((i) => i.level === 'error')) {
    return {
      ok: false,
      message: 'Correct the errors on this timecard before approving it.',
      timecard: viewTimecard({ userId, date, autoGenerate: false }),
    };
  }

  db.prepare(
    `UPDATE timecards SET approved = ?, approved_by = ?, approved_at = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(approved ? 1 : 0, approved ? actorId : null, approved ? nowStamp() : null, record.id);

  audit(actorId, 'timecard', record.id, approved ? 'APPROVE' : 'UNAPPROVE', { userId, payrollDate: date });

  const who = getUser(userId)?.name ?? `#${userId}`;
  emit('timecard.approved', userId, `${who}'s ${date} timecard was ${approved ? 'approved' : 'unapproved'}`, {
    payrollDate: date,
    approved,
  });
  // An approval is what makes the day payable, so the advisor is told — and an
  // approval being *removed* matters more to them, not less.
  notify(
    [userId],
    approved ? 'Timecard approved' : 'Approval removed',
    approved
      ? `Your ${date} timecard has been approved and will go to payroll as it stands.`
      : `The approval on your ${date} timecard was removed while it is looked at again.`,
    approved ? 'INFO' : 'WARN',
  );

  return {
    ok: true,
    message: approved ? 'Timecard approved.' : 'Approval removed.',
    timecard: viewTimecard({ userId, date, autoGenerate: false }),
  };
}

export function setManualCheck(params: {
  userId: number;
  date: DateStr;
  status: string;
  actorId: number;
}): { ok: boolean; message: string } {
  const record = getTimecardRecord(params.userId, params.date);
  if (!record) return { ok: false, message: 'No timecard for that date.' };
  if (!record.protect_date) {
    return {
      ok: false,
      message: 'A manual check can only be requested against a timecard payroll has already run.',
    };
  }
  db.prepare("UPDATE timecards SET manual_check_status = ?, updated_at = datetime('now') WHERE id = ?").run(
    params.status,
    record.id,
  );
  audit(params.actorId, 'timecard', record.id, 'MANUAL_CHECK', { status: params.status });
  return { ok: true, message: `Manual check status set to ${params.status}.` };
}

export interface PayrollSummaryRow {
  userId: number;
  employeeId: string;
  name: string;
  payrollDate: DateStr;
  shiftNo: number;
  codes: string[];
  regular: string;
  overtime: string;
  absence: string;
  extraHours: string;
  approved: boolean;
  assumedOff: boolean;
  inProgress: boolean;
  protectDate: string | null;
  hasErrors: boolean;
  exceptions: string[];
}

export function payrollSummary(params: {
  userIds: number[];
  start: DateStr;
  end: DateStr;
  actorId: number | null;
}): PayrollSummaryRow[] {
  const out: PayrollSummaryRow[] = [];
  for (const userId of params.userIds) {
    const dates = (
      db
        .prepare(
          `SELECT DISTINCT payroll_date FROM (
             SELECT payroll_date FROM schedules WHERE user_id = ? AND payroll_date BETWEEN ? AND ?
             UNION SELECT payroll_date FROM timecards WHERE user_id = ? AND payroll_date BETWEEN ? AND ?
           ) ORDER BY payroll_date`,
        )
        .all(userId, params.start, params.end, userId, params.start, params.end) as { payroll_date: string }[]
    ).map((r) => r.payroll_date);

    for (const date of dates) {
      const view = viewTimecard({ userId, date, actorId: params.actorId });
      if (!view) continue;
      out.push({
        userId,
        employeeId: view.employeeId,
        name: view.userName,
        payrollDate: date,
        shiftNo: view.shiftNo,
        codes: view.summary.codes,
        regular: view.summary.formatted.regular,
        overtime: view.summary.formatted.overtime,
        absence: view.summary.formatted.absence,
        extraHours: view.summary.formatted.extraHours,
        approved: view.approved,
        assumedOff: view.assumedOff,
        inProgress: view.inProgress,
        protectDate: view.protectDate,
        hasErrors: view.issues.some((i) => i.level === 'error'),
        exceptions: view.exceptions,
      });
    }
  }
  return out.sort((a, b) => a.payrollDate.localeCompare(b.payrollDate) || a.name.localeCompare(b.name));
}

/**
 * Run payroll for a period: stamp a protect date on every card in range so any
 * later edit is treated as a post-payroll correction.
 */
export function runPayroll(params: {
  region: string;
  start: DateStr;
  end: DateStr;
  actorId: number;
}): { protectedCards: number } {
  const info = db
    .prepare(
      `UPDATE timecards SET protect_date = ?, updated_at = datetime('now')
       WHERE payroll_date BETWEEN ? AND ?
         AND user_id IN (SELECT id FROM users WHERE region = ?)`,
    )
    .run(params.end, params.start, params.end, params.region);

  db.prepare("UPDATE payroll_periods SET run_at = datetime('now') WHERE region = ? AND start_date = ?").run(
    params.region,
    params.start,
  );

  audit(params.actorId, 'payroll', `${params.region}:${params.start}`, 'RUN', {
    end: params.end,
    cards: info.changes,
  });
  return { protectedCards: info.changes };
}
