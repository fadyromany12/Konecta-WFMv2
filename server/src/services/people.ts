/**
 * People, visibility and groups.
 *
 * Who a user may see is derived from the reporting hierarchy rather than
 * configured by hand: a supervisor sees their own team, and — as the operating
 * model intends — the teams reporting up to the same second-level manager, so
 * peers can cover for each other without raising an access request. Delegation
 * adds the delegator's team on top for as long as the delegation stands.
 */

import { db, placeholders } from '../db/index.js';
import {
  SHIFT_RULE_MAP,
  DEFAULT_SHIFT_RULE,
  SUPERVISOR_ROLES,
  type Role,
  type ShiftRule,
} from '../domain/reference.js';
import { diffDays, type DateStr } from '../domain/time.js';

export { placeholders };

export interface UserRow {
  id: number;
  employee_id: string;
  name: string;
  email: string;
  role: Role;
  manager_id: number | null;
  project_id: string | null;
  department_code: string;
  status: string;
  shift_rule: string;
  region: string;
  hire_date: string | null;
  /** Last working day for a leaver. Null for everybody who is staying. */
  leave_date: string | null;
}

export function getUser(id: number): Promise<UserRow | undefined> {
  return db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
}

export function getUserByEmail(email: string): Promise<(UserRow & { password_hash: string }) | undefined> {
  return db.get<UserRow & { password_hash: string }>('SELECT * FROM users WHERE lower(email) = lower(?)', [
    email,
  ]);
}

export function getUserByEmployeeId(employeeId: string): Promise<UserRow | undefined> {
  return db.get<UserRow>('SELECT * FROM users WHERE employee_id = ?', [employeeId]);
}

/**
 * The whole hierarchy, read once.
 *
 * The previous version walked the tree with one query per node, which is fine
 * against a local SQLite file and ruinous against a database across a network:
 * a seventeen-person org became seventeen round trips before a single screen
 * could be drawn. One read builds the parent map, and every descendant question
 * is then answered in memory.
 */
async function reportingMap(): Promise<Map<number, number[]>> {
  const rows = await db.all<{ id: number; manager_id: number | null }>(
    'SELECT id, manager_id FROM users',
  );
  const children = new Map<number, number[]>();
  for (const row of rows) {
    if (row.manager_id === null) continue;
    const list = children.get(row.manager_id);
    if (list) list.push(row.id);
    else children.set(row.manager_id, [row.id]);
  }
  return children;
}

function descendantsOf(children: Map<number, number[]>, id: number): number[] {
  const seen = new Set<number>();
  const queue = [...(children.get(id) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(children.get(next) ?? []));
  }
  return [...seen];
}

/** Everyone below this user in the hierarchy, at any depth. */
export async function descendants(id: number): Promise<number[]> {
  return descendantsOf(await reportingMap(), id);
}

/** Users who have delegated their team to this user. */
export async function delegators(id: number): Promise<number[]> {
  const rows = await db.all<{ user_id: number }>(
    'SELECT user_id FROM alternates WHERE alternate_user_id = ?',
    [id],
  );
  return rows.map((r) => r.user_id);
}

export async function visibleUserIds(viewer: UserRow): Promise<number[]> {
  if (viewer.role === 'ADMIN') {
    const rows = await db.all<{ id: number }>('SELECT id FROM users');
    return rows.map((r) => r.id);
  }

  const [children, delegatedBy] = await Promise.all([reportingMap(), delegators(viewer.id)]);
  const ids = new Set<number>([viewer.id, ...descendantsOf(children, viewer.id)]);

  // Peers reporting up to the same second-level manager.
  if (viewer.manager_id) {
    const manager = await getUser(viewer.manager_id);
    const secondLevel = manager?.manager_id ?? manager?.id ?? null;
    if (secondLevel) for (const id of descendantsOf(children, secondLevel)) ids.add(id);
  }

  for (const delegatorId of delegatedBy) {
    ids.add(delegatorId);
    for (const id of descendantsOf(children, delegatorId)) ids.add(id);
  }

  return [...ids];
}

/**
 * May this user act on, or see, another person's record?
 *
 * `visibleUserIds` deliberately includes peers under the same second-level
 * manager, so a supervisor can cover for a colleague's team without an access
 * request. That is the right rule for the Who dropdown and the wrong one for
 * a record: applied to an advisor it returned their whole team, which meant one
 * advisor could read another's timecard, leave balance and personal history —
 * their sick leave among it. Peer cover is a supervisor's job, so only a
 * supervising role reaches past themselves at all.
 */
export async function canManage(viewer: UserRow, targetId: number): Promise<boolean> {
  if (viewer.id === targetId) return true;
  if (!SUPERVISOR_ROLES.includes(viewer.role)) return false;
  return (await visibleUserIds(viewer)).includes(targetId);
}

export interface GroupSummary {
  key: string;
  name: string;
  type: 'SYSTEM' | 'CUSTOM' | 'ALT' | 'SELF';
  memberIds: number[];
}

/**
 * The Who dropdown. System groups are prefixed `--`, custom groups `-`, and
 * delegated teams `ALT_`, so the prefix alone tells a user where a group came
 * from and whether they can delete it.
 */
export async function listGroups(viewer: UserRow): Promise<GroupSummary[]> {
  const groups: GroupSummary[] = [];
  const visibleIds = await visibleUserIds(viewer);
  const visible = new Set(visibleIds);
  const children = await reportingMap();

  groups.push({ key: '-Me', name: '-Me', type: 'SELF', memberIds: [viewer.id] });

  // One system group per supervisor whose team the viewer can see.
  const supervisors = await db.all<{ id: number; employee_id: string; name: string }>(
    `SELECT DISTINCT m.id, m.employee_id, m.name
     FROM users u JOIN users m ON m.id = u.manager_id
     WHERE u.id IN (${placeholders(visible.size)})`,
    visibleIds,
  );

  for (const sup of supervisors) {
    const members = descendantsOf(children, sup.id).filter((id) => visible.has(id));
    if (members.length === 0) continue;
    groups.push({
      key: `--${sup.employee_id}`,
      name: `--${sup.employee_id} ${sup.name}`,
      type: 'SYSTEM',
      memberIds: members,
    });
  }

  for (const delegatorId of await delegators(viewer.id)) {
    const delegator = await getUser(delegatorId);
    if (!delegator) continue;
    groups.push({
      key: `ALT_${delegator.employee_id}`,
      name: `ALT_${delegator.employee_id} ${delegator.name}`,
      type: 'ALT',
      memberIds: [delegatorId, ...descendantsOf(children, delegatorId)],
    });
  }

  const custom = await db.all<{ id: number; name: string }>(
    'SELECT id, name FROM groups WHERE owner_id = ? AND type = ?',
    [viewer.id, 'CUSTOM'],
  );

  for (const group of custom) {
    const rows = await db.all<{ user_id: number }>(
      'SELECT user_id FROM group_members WHERE group_id = ?',
      [group.id],
    );
    groups.push({
      key: `-${group.name}`,
      name: `-${group.name}`,
      type: 'CUSTOM',
      memberIds: rows.map((r) => r.user_id).filter((id) => visible.has(id)),
    });
  }

  return groups;
}

export async function resolveGroup(viewer: UserRow, key: string | undefined): Promise<number[]> {
  if (!key || key === 'ALL') return visibleUserIds(viewer);
  const group = (await listGroups(viewer)).find((g) => g.key === key);
  return group ? group.memberIds : [];
}

/**
 * The shift rule in force for a user on a given date. Changes are stored as
 * future-dated records, so history stays intact and a rule change never
 * retroactively rewrites how a past shift was judged.
 */
export async function effectiveShiftRule(userId: number, date: DateStr): Promise<ShiftRule> {
  const [user, change] = await Promise.all([
    getUser(userId),
    db.get<{ shift_rule: string }>(
      `SELECT shift_rule FROM shift_rule_changes
       WHERE user_id = ? AND effective_date <= ?
       ORDER BY effective_date DESC, id DESC LIMIT 1`,
      [userId, date],
    ),
  ]);

  const code = change?.shift_rule ?? user?.shift_rule ?? DEFAULT_SHIFT_RULE;
  return SHIFT_RULE_MAP.get(code) ?? SHIFT_RULE_MAP.get(DEFAULT_SHIFT_RULE)!;
}

export async function pendingShiftRuleChanges(userId: number, today: DateStr) {
  const rows = await db.all<any>(
    `SELECT c.*, u.name AS created_by_name FROM shift_rule_changes c
     JOIN users u ON u.id = c.created_by
     WHERE c.user_id = ? ORDER BY c.effective_date DESC LIMIT 20`,
    [userId],
  );
  return rows.map((row) => ({ ...row, pending: diffDays(today, row.effective_date) > 0 }));
}
