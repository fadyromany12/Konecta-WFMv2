/**
 * Bradford scores for people a supervisor can see.
 *
 * The arithmetic is in `domain/bradford.ts`. This is the part that knows
 * absence is recorded on timecard rows, and that whether two absences are one
 * occasion depends on the roster in between.
 */

import { db, placeholders } from '../db/index.js';
import {
  COUNTED_CODES,
  PLANNED_CODES,
  bradford,
  describe,
  daysSinceLast,
  labelFor,
  windowStart,
  type BradfordResult,
} from '../domain/bradford.js';
import { todayStr, type DateStr } from '../domain/time.js';

export interface AbsenceProfile extends BradfordResult {
  userId: number;
  name: string;
  employeeId: string;
  managerName: string | null;
  summary: string;
  bandLabel: string;
  daysSinceLast: number | null;
}

/**
 * Score everybody in view over a rolling window.
 *
 * Reads all the absence rows for the whole group in one query and all the
 * rostered dates in another, then does the grouping in memory. The alternative
 * — a query per person — is fifty-five round trips for a screen that renders
 * one table, and the seed already showed what that costs against a hosted
 * database.
 */
export async function absenceProfiles(params: {
  userIds: number[];
  start?: DateStr;
  end?: DateStr;
}): Promise<{ start: DateStr; end: DateStr; profiles: AbsenceProfile[] }> {
  const end = params.end ?? todayStr();
  const start = params.start ?? windowStart(end);

  if (params.userIds.length === 0) return { start, end, profiles: [] };

  const ids = params.userIds;
  const marks = placeholders(ids.length);
  const relevant = [...COUNTED_CODES, ...PLANNED_CODES];

  const [absences, rostered, people] = await Promise.all([
    // DISTINCT because a day can carry several absent rows — a split shift, or
    // an absence recorded against two activities — and that is one absent day.
    db.all<{ user_id: number; payroll_date: string; code: string }>(
      `SELECT DISTINCT t.user_id, t.payroll_date, r.code
       FROM timecards t
       JOIN timecard_rows r ON r.timecard_id = t.id
       WHERE t.user_id IN (${marks})
         AND t.payroll_date BETWEEN ? AND ?
         AND r.code IN (${placeholders(relevant.length)})
       ORDER BY t.payroll_date`,
      [...ids, start, end, ...relevant],
    ),
    // The days somebody was actually rostered. Two absences with only rest days
    // between them are one occasion, and without this they would score four
    // times higher for having been ill across a weekend.
    db.all<{ user_id: number; payroll_date: string }>(
      `SELECT user_id, payroll_date FROM schedules
       WHERE user_id IN (${marks}) AND payroll_date BETWEEN ? AND ?
       ORDER BY payroll_date`,
      [...ids, start, end],
    ),
    db.all<{ id: number; name: string; employee_id: string; manager_name: string | null }>(
      `SELECT u.id, u.name, u.employee_id, m.name AS manager_name
       FROM users u LEFT JOIN users m ON m.id = u.manager_id
       WHERE u.id IN (${marks})`,
      ids,
    ),
  ]);

  const absenceBy = new Map<number, { date: DateStr; code: string }[]>();
  for (const row of absences) {
    const list = absenceBy.get(row.user_id) ?? [];
    list.push({ date: row.payroll_date, code: row.code });
    absenceBy.set(row.user_id, list);
  }

  const rosterBy = new Map<number, DateStr[]>();
  for (const row of rostered) {
    const list = rosterBy.get(row.user_id) ?? [];
    list.push(row.payroll_date);
    rosterBy.set(row.user_id, list);
  }

  const profiles: AbsenceProfile[] = [];

  for (const person of people) {
    const theirAbsences = absenceBy.get(person.id) ?? [];
    const roster = rosterBy.get(person.id) ?? [];

    // The rostered day immediately before a given date, or null if there is
    // none in the window. Sorted once per person, then scanned.
    const sortedRoster = [...new Set(roster)].sort();
    const workingDayBefore = (date: DateStr): DateStr | null => {
      let previous: DateStr | null = null;
      for (const day of sortedRoster) {
        if (day >= date) break;
        previous = day;
      }
      return previous;
    };

    const result = bradford({
      absences: theirAbsences,
      plannedDays: theirAbsences.filter((a) => (PLANNED_CODES as readonly string[]).includes(a.code))
        .length,
      workingDayBefore,
    });

    profiles.push({
      ...result,
      userId: person.id,
      name: person.name,
      employeeId: person.employee_id,
      managerName: person.manager_name,
      summary: describe(result),
      bandLabel: labelFor(result.band),
      daysSinceLast: daysSinceLast(result, end),
    });
  }

  // Worst first — the screen exists to surface the handful worth a
  // conversation, not to list everybody alphabetically.
  profiles.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return { start, end, profiles };
}
