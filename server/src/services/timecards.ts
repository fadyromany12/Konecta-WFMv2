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

async function readRows(timecardId: number): Promise<TimecardRow[]> {
  const rows = await db.all<any>(
    'SELECT id, code, project, activity, start_at, end_at FROM timecard_rows WHERE timecard_id = ? ORDER BY sort_order',
    [timecardId],
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    project: r.project,
    activity: r.activity,
    startAt: r.start_at,
    endAt: r.end_at,
  }));
}

async function writeRows(timecardId: number, rows: TimecardRow[]): Promise<void> {
  await db.run('DELETE FROM timecard_rows WHERE timecard_id = ?', [timecardId]);
  for (const [i, row] of rows.entries()) {
    await db.run(
      'INSERT INTO timecard_rows (timecard_id, code, project, activity, start_at, end_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [timecardId, row.code, row.project, row.activity, row.startAt, row.endAt, i],
    );
  }
}

async function getPunches(userId: number, date: DateStr): Promise<Punch[]> {
  // A shift is anchored to its payroll date but its punches can spill into the
  // following calendar day, so the window deliberately runs past midnight.
  const from = `${date} 00:00`;
  const to = `${addDays(date, 1)} 23:59`;
  const rows = await db.all<any>(
    'SELECT at, type, activity FROM punches WHERE user_id = ? AND at BETWEEN ? AND ? ORDER BY at',
    [userId, from, to],
  );
  return rows.map((p) => ({ at: p.at, type: p.type, activity: p.activity }));
}

/**
 * Punches belonging to a payroll date: everything from the scheduled shift
 * start until the shift ends, rather than a naive calendar day.
 */
async function punchesForShift(userId: number, date: DateStr): Promise<Punch[]> {
  const [shifts, all] = await Promise.all([getShifts(userId, date), getPunches(userId, date)]);
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

export function getTimecardRecord(
  userId: number,
  date: DateStr,
  shiftNo = 1,
): Promise<TimecardRecord | undefined> {
  return db.get<TimecardRecord>(
    'SELECT * FROM timecards WHERE user_id = ? AND payroll_date = ? AND shift_no = ?',
    [userId, date, shiftNo],
  );
}

/**
 * Generate or refresh a card from punches. Cards a human has edited are left
 * alone unless `force` is set, which is what the explicit Rebuild action does.
 */
export async function generateTimecard(params: {
  userId: number;
  date: DateStr;
  actorId: number | null;
  force?: boolean;
  now?: string;
}): Promise<TimecardRecord | undefined> {
  const { userId, date, actorId, force = false } = params;
  const now = params.now ?? nowStamp();
  const existing = await getTimecardRecord(userId, date);
  if (existing && existing.edited && !force) return existing;
  if (existing && existing.approved && !force) return existing;

  const user = await getUser(userId);
  if (!user) return existing;

  const [shifts, punches, rule] = await Promise.all([
    getShifts(userId, date),
    punchesForShift(userId, date),
    effectiveShiftRule(userId, date),
  ]);
  if (shifts.length === 0 && punches.length === 0) return existing;

  const built = buildTimecard({
    shifts,
    punches,
    rule,
    project: user.project_id ?? '',
    now,
  });

  if (built.rows.length === 0 && !existing) return undefined;

  return transact(async () => {
    let id = existing?.id;
    if (id === undefined) {
      id = await db.insert(
        'INSERT INTO timecards (user_id, payroll_date, shift_no, assumed_off, in_progress, notes) VALUES (?, ?, 1, ?, ?, ?)',
        [userId, date, built.assumedOff ? 1 : 0, built.inProgress ? 1 : 0, JSON.stringify(built.notes)],
      );
    } else {
      await db.run(
        'UPDATE timecards SET assumed_off = ?, in_progress = ?, notes = ?, edited = 0, updated_at = ? WHERE id = ?',
        [built.assumedOff ? 1 : 0, built.inProgress ? 1 : 0, JSON.stringify(built.notes), nowStamp(), id],
      );
    }
    await writeRows(id, built.rows);
    if (force) await audit(actorId, 'timecard', id, 'REBUILD', { rows: built.rows.length });
    return getTimecardRecord(userId, date);
  });
}

export async function viewTimecard(params: {
  userId: number;
  date: DateStr;
  shiftNo?: number;
  autoGenerate?: boolean;
  actorId?: number | null;
}): Promise<TimecardView | null> {
  const { userId, date, shiftNo = 1, autoGenerate = true, actorId = null } = params;
  if (autoGenerate) await generateTimecard({ userId, date, actorId });

  const record = await getTimecardRecord(userId, date, shiftNo);
  if (!record) return null;

  const user = await getUser(userId);
  const rows = await readRows(record.id);
  const approver = record.approved_by ? await getUser(record.approved_by) : null;

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

export async function saveTimecard(params: {
  userId: number;
  date: DateStr;
  rows: TimecardRow[];
  actorId: number;
  actorRole: Role;
  today?: DateStr;
}): Promise<SaveTimecardResult> {
  const { userId, date, actorId, actorRole } = params;
  const today = params.today ?? todayStr();
  const record = await getTimecardRecord(userId, date);

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
      timecard: await viewTimecard({ userId, date, autoGenerate: false }),
    };
  }

  const rows = mergeContiguous(sortRows(params.rows));
  const issues = validateTimecard(rows, date);
  if (issues.some((i) => i.level === 'error')) {
    return { ok: false, issues, decision, timecard: null };
  }

  await transact(async () => {
    let id = record?.id;
    if (id === undefined) {
      id = await db.insert('INSERT INTO timecards (user_id, payroll_date, shift_no, edited) VALUES (?, ?, 1, 1)', [
        userId,
        date,
      ]);
    } else {
      await db.run('UPDATE timecards SET edited = 1, updated_at = ? WHERE id = ?', [nowStamp(), id]);
    }
    const before = record ? await readRows(record.id) : [];
    await writeRows(id, rows);
    await audit(actorId, 'timecard', id, decision.postPayroll ? 'EDIT_POST_PAYROLL' : 'EDIT', {
      payrollDate: date,
      before,
      after: rows,
    });
  });

  return {
    ok: true,
    issues,
    decision,
    timecard: await viewTimecard({ userId, date, autoGenerate: false }),
  };
}

export async function setApproval(params: {
  userId: number;
  date: DateStr;
  approved: boolean;
  actorId: number;
  actorRole: Role;
  today?: DateStr;
}): Promise<{ ok: boolean; message: string; timecard: TimecardView | null }> {
  const { userId, date, approved, actorId } = params;
  const record = await getTimecardRecord(userId, date);
  if (!record) return { ok: false, message: 'No timecard for that date.', timecard: null };

  if (record.in_progress && approved) {
    return {
      ok: false,
      message: 'The shift is still in progress. Approve once the advisor has clocked off.',
      timecard: await viewTimecard({ userId, date, autoGenerate: false }),
    };
  }

  const rows = await readRows(record.id);
  const issues = validateTimecard(rows, date);
  if (approved && issues.some((i) => i.level === 'error')) {
    return {
      ok: false,
      message: 'Correct the errors on this timecard before approving it.',
      timecard: await viewTimecard({ userId, date, autoGenerate: false }),
    };
  }

  await db.run('UPDATE timecards SET approved = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?', [
    approved ? 1 : 0,
    approved ? actorId : null,
    approved ? nowStamp() : null,
    nowStamp(),
    record.id,
  ]);

  await audit(actorId, 'timecard', record.id, approved ? 'APPROVE' : 'UNAPPROVE', { userId, payrollDate: date });

  const who = (await getUser(userId))?.name ?? `#${userId}`;
  emit('timecard.approved', userId, `${who}'s ${date} timecard was ${approved ? 'approved' : 'unapproved'}`, {
    payrollDate: date,
    approved,
  });
  // An approval is what makes the day payable, so the advisor is told — and an
  // approval being *removed* matters more to them, not less.
  await notify(
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
    timecard: await viewTimecard({ userId, date, autoGenerate: false }),
  };
}

export async function setManualCheck(params: {
  userId: number;
  date: DateStr;
  status: string;
  actorId: number;
}): Promise<{ ok: boolean; message: string }> {
  const record = await getTimecardRecord(params.userId, params.date);
  if (!record) return { ok: false, message: 'No timecard for that date.' };
  if (!record.protect_date) {
    return {
      ok: false,
      message: 'A manual check can only be requested against a timecard payroll has already run.',
    };
  }
  await db.run('UPDATE timecards SET manual_check_status = ?, updated_at = ? WHERE id = ?', [
    params.status,
    nowStamp(),
    record.id,
  ]);
  await audit(params.actorId, 'timecard', record.id, 'MANUAL_CHECK', { status: params.status });
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

export async function payrollSummary(params: {
  userIds: number[];
  start: DateStr;
  end: DateStr;
  actorId: number | null;
}): Promise<PayrollSummaryRow[]> {
  const out: PayrollSummaryRow[] = [];
  for (const userId of params.userIds) {
    // Postgres requires a name for a derived table; SQLite does not mind one.
    const rows = await db.all<{ payroll_date: string }>(
      `SELECT DISTINCT payroll_date FROM (
         SELECT payroll_date FROM schedules WHERE user_id = ? AND payroll_date BETWEEN ? AND ?
         UNION SELECT payroll_date FROM timecards WHERE user_id = ? AND payroll_date BETWEEN ? AND ?
       ) AS days ORDER BY payroll_date`,
      [userId, params.start, params.end, userId, params.start, params.end],
    );

    for (const { payroll_date: date } of rows) {
      const view = await viewTimecard({ userId, date, actorId: params.actorId });
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
export async function runPayroll(params: {
  region: string;
  start: DateStr;
  end: DateStr;
  actorId: number;
}): Promise<{ protectedCards: number }> {
  const now = nowStamp();
  const info = await db.run(
    `UPDATE timecards SET protect_date = ?, updated_at = ?
     WHERE payroll_date BETWEEN ? AND ?
       AND user_id IN (SELECT id FROM users WHERE region = ?)`,
    [params.end, now, params.start, params.end, params.region],
  );

  await db.run('UPDATE payroll_periods SET run_at = ? WHERE region = ? AND start_date = ?', [
    now,
    params.region,
    params.start,
  ]);

  await audit(params.actorId, 'payroll', `${params.region}:${params.start}`, 'RUN', {
    end: params.end,
    cards: info.changes,
  });
  return { protectedCards: info.changes };
}
