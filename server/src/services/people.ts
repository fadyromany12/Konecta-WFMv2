/**
 * People, visibility and groups.
 *
 * Who a user may see is derived from the reporting hierarchy rather than
 * configured by hand: a supervisor sees their own team, and — as the operating
 * model intends — the teams reporting up to the same second-level manager, so
 * peers can cover for each other without raising an access request. Delegation
 * adds the delegator's team on top for as long as the delegation stands.
 */

import { db } from '../db/index.js';
import { SHIFT_RULE_MAP, DEFAULT_SHIFT_RULE, type Role, type ShiftRule } from '../domain/reference.js';
import { diffDays, type DateStr } from '../domain/time.js';

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
}

export function getUser(id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function getUserByEmail(email: string): (UserRow & { password_hash: string }) | undefined {
  return db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email) as
    | (UserRow & { password_hash: string })
    | undefined;
}

export function getUserByEmployeeId(employeeId: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE employee_id = ?').get(employeeId) as UserRow | undefined;
}

function directReports(id: number): number[] {
  return (db.prepare('SELECT id FROM users WHERE manager_id = ?').all(id) as { id: number }[]).map((r) => r.id);
}

/** Everyone below this user in the hierarchy, at any depth. */
export function descendants(id: number): number[] {
  const seen = new Set<number>();
  const queue = [...directReports(id)];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...directReports(next));
  }
  return [...seen];
}

/** Users who have delegated their team to this user. */
export function delegators(id: number): number[] {
  return (
    db.prepare('SELECT user_id FROM alternates WHERE alternate_user_id = ?').all(id) as { user_id: number }[]
  ).map((r) => r.user_id);
}

export function visibleUserIds(viewer: UserRow): number[] {
  if (viewer.role === 'ADMIN') {
    return (db.prepare('SELECT id FROM users').all() as { id: number }[]).map((r) => r.id);
  }

  const ids = new Set<number>([viewer.id, ...descendants(viewer.id)]);

  // Peers reporting up to the same second-level manager.
  if (viewer.manager_id) {
    const manager = getUser(viewer.manager_id);
    const secondLevel = manager?.manager_id ?? manager?.id ?? null;
    if (secondLevel) for (const id of descendants(secondLevel)) ids.add(id);
  }

  for (const delegatorId of delegators(viewer.id)) {
    ids.add(delegatorId);
    for (const id of descendants(delegatorId)) ids.add(id);
  }

  return [...ids];
}

export function canManage(viewer: UserRow, targetId: number): boolean {
  if (viewer.id === targetId) return true;
  return visibleUserIds(viewer).includes(targetId);
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
export function listGroups(viewer: UserRow): GroupSummary[] {
  const groups: GroupSummary[] = [];
  const visible = new Set(visibleUserIds(viewer));

  groups.push({ key: '-Me', name: '-Me', type: 'SELF', memberIds: [viewer.id] });

  // One system group per supervisor whose team the viewer can see.
  const supervisors = db
    .prepare(
      `SELECT DISTINCT m.id, m.employee_id, m.name
       FROM users u JOIN users m ON m.id = u.manager_id
       WHERE u.id IN (${placeholders(visible.size)})`,
    )
    .all(...visible) as { id: number; employee_id: string; name: string }[];

  for (const sup of supervisors) {
    const members = descendants(sup.id).filter((id) => visible.has(id));
    if (members.length === 0) continue;
    groups.push({
      key: `--${sup.employee_id}`,
      name: `--${sup.employee_id} ${sup.name}`,
      type: 'SYSTEM',
      memberIds: members,
    });
  }

  for (const delegatorId of delegators(viewer.id)) {
    const delegator = getUser(delegatorId);
    if (!delegator) continue;
    groups.push({
      key: `ALT_${delegator.employee_id}`,
      name: `ALT_${delegator.employee_id} ${delegator.name}`,
      type: 'ALT',
      memberIds: [delegatorId, ...descendants(delegatorId)],
    });
  }

  const custom = db.prepare('SELECT id, name FROM groups WHERE owner_id = ? AND type = ?').all(
    viewer.id,
    'CUSTOM',
  ) as { id: number; name: string }[];

  for (const group of custom) {
    const members = (
      db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(group.id) as {
        user_id: number;
      }[]
    ).map((r) => r.user_id);
    groups.push({
      key: `-${group.name}`,
      name: `-${group.name}`,
      type: 'CUSTOM',
      memberIds: members.filter((id) => visible.has(id)),
    });
  }

  return groups;
}

export function resolveGroup(viewer: UserRow, key: string | undefined): number[] {
  if (!key || key === 'ALL') return visibleUserIds(viewer);
  const group = listGroups(viewer).find((g) => g.key === key);
  return group ? group.memberIds : [];
}

/**
 * The shift rule in force for a user on a given date. Changes are stored as
 * future-dated records, so history stays intact and a rule change never
 * retroactively rewrites how a past shift was judged.
 */
export function effectiveShiftRule(userId: number, date: DateStr): ShiftRule {
  const user = getUser(userId);
  const change = db
    .prepare(
      `SELECT shift_rule FROM shift_rule_changes
       WHERE user_id = ? AND effective_date <= ?
       ORDER BY effective_date DESC, id DESC LIMIT 1`,
    )
    .get(userId, date) as { shift_rule: string } | undefined;

  const code = change?.shift_rule ?? user?.shift_rule ?? DEFAULT_SHIFT_RULE;
  return SHIFT_RULE_MAP.get(code) ?? SHIFT_RULE_MAP.get(DEFAULT_SHIFT_RULE)!;
}

export function pendingShiftRuleChanges(userId: number, today: DateStr) {
  return db
    .prepare(
      `SELECT c.*, u.name AS created_by_name FROM shift_rule_changes c
       JOIN users u ON u.id = c.created_by
       WHERE c.user_id = ? ORDER BY c.effective_date DESC LIMIT 20`,
    )
    .all(userId)
    .map((row: any) => ({ ...row, pending: diffDays(today, row.effective_date) > 0 }));
}

export function placeholders(n: number): string {
  return n === 0 ? 'NULL' : new Array(n).fill('?').join(',');
}
