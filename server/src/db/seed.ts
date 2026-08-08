/**
 * Seed a working demonstration dataset.
 *
 * The data is deliberately not tidy. It contains the situations a supervisor
 * actually has to deal with — a late clock-on, a break taken an hour early,
 * training nobody scheduled, a meal that overran, a shift with no clock-off,
 * and a no call no show — because a workforce tool that only ever shows clean
 * days teaches you nothing about using it.
 *
 * Run with: npm run seed  (add --force to rebuild an existing database)
 */

import bcrypt from 'bcryptjs';
import { audit, db, ensureSchema, transact } from './index.js';
import { ACTIVITIES } from '../domain/reference.js';
import type { ScheduleActivityKey } from '../domain/reference.js';
import type { ScheduleShift } from '../domain/schedule.js';
import { addDays, nowStamp, stamp, todayStr, type DateStr } from '../domain/time.js';
import { saveShifts } from '../services/scheduling.js';
import { generateTimecard, runPayroll } from '../services/timecards.js';

export const DEMO_PASSWORD = 'pulse123';
const PASSWORD = DEMO_PASSWORD;

interface SeedRow {
  time: string;
  activityKey: ScheduleActivityKey;
}

const NIGHT_SHIFT: SeedRow[] = [
  { time: '23:00', activityKey: 'SHIFT_START' },
  { time: '01:00', activityKey: 'BREAK' },
  { time: '01:15', activityKey: 'OPEN_TIME' },
  { time: '03:00', activityKey: 'LUNCH' },
  { time: '03:30', activityKey: 'OPEN_TIME' },
  { time: '06:15', activityKey: 'BREAK' },
  { time: '06:30', activityKey: 'OPEN_TIME' },
];
const NIGHT_END = '07:30';

const DAY_SHIFT: SeedRow[] = [
  { time: '09:00', activityKey: 'SHIFT_START' },
  { time: '11:00', activityKey: 'BREAK' },
  { time: '11:15', activityKey: 'OPEN_TIME' },
  { time: '13:00', activityKey: 'LUNCH' },
  { time: '13:30', activityKey: 'OPEN_TIME' },
  { time: '15:30', activityKey: 'BREAK' },
  { time: '15:45', activityKey: 'OPEN_TIME' },
];
const DAY_END = '17:30';

/**
 * Build the demonstration dataset. Safe to call at any time: it does nothing if
 * the database already has users unless `force` is set. Exported so a
 * serverless cold start can seed its own ephemeral database, which is how the
 * hosted testing deployment gets its data.
 */
export async function seed(options: { force?: boolean; quiet?: boolean } = {}): Promise<{ seeded: boolean }> {
  const { force = false, quiet = false } = options;
  const say = (...args: unknown[]) => {
    if (!quiet) console.log(...args);
  };

  const existing = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
  const userCount = Number(existing?.n ?? 0);
  if (userCount > 0 && !force) {
    say(`Database already has ${userCount} users. Re-run with --force to rebuild.`);
    return { seeded: false };
  }

  if (force) {
    await transact(async () => {
      for (const table of [
        'extra_hours_bids',
        'extra_hours_offers',
        'shift_swaps',
        'forecast_intervals',
        'forecast_settings',
        'audit_log',
        'messages',
        'time_off_requests',
        'accruals',
        'alternates',
        'group_members',
        'groups',
        'timecard_rows',
        'timecards',
        'punches',
        'schedule_rows',
        'schedules',
        'shift_rule_changes',
        'project_activities',
        'project_departments',
        'payroll_periods',
        'users',
        'projects',
      ]) {
        await db.run(`DELETE FROM ${table}`);
      }
      // SQLite keeps its own counter table; Postgres owns identity sequences
      // itself and has nothing equivalent to reset here.
      if (db.dialect === 'sqlite') {
        await db.run("DELETE FROM sqlite_sequence WHERE name NOT IN ('')");
      }
    });
  }

  const today = todayStr();
  const hash = bcrypt.hashSync(PASSWORD, 10);

  // ---------------------------------------------------------------- projects
  const projects = [
    { id: 'A123', name: 'Konecta Care', fn: '111222333', site: 'Cairo', region: 'EMEA' },
    { id: 'A456', name: 'Konecta Care', fn: '111222333', site: 'Lisbon', region: 'EMEA' },
    { id: 'B900', name: 'Retail Support', fn: '444555666', site: 'Cairo', region: 'EMEA' },
  ];
  await transact(async () => {
    for (const p of projects) {
      await db.run(
        'INSERT INTO projects (activity_id, name, financial_number, site, region) VALUES (?, ?, ?, ?, ?)',
        [p.id, p.name, p.fn, p.site, p.region],
      );
      for (const dept of ['10000', '10002', '10007']) {
        await db.run('INSERT INTO project_departments (activity_id, department_code) VALUES (?, ?)', [
          p.id,
          dept,
        ]);
      }
      for (const activity of ACTIVITIES) {
        await db.run('INSERT INTO project_activities (activity_id, activity_code) VALUES (?, ?)', [
          p.id,
          activity.code,
        ]);
      }
    }
  });

  // ------------------------------------------------------------------- users
  // Positional rather than named parameters: the two drivers spell named
  // parameters differently, and the argument list here is fixed anyway.
  const USER_SQL = `INSERT INTO users (employee_id, name, email, password_hash, role, manager_id, project_id, department_code, status, shift_rule, region, hire_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  async function addUser(u: {
    employee_id: string;
    name: string;
    email: string;
    role: string;
    manager_id: number | null;
    project_id: string | null;
    shift_rule?: string;
    department_code?: string;
    status?: string;
    hire_date?: string;
  }): Promise<number> {
    return db.insert(USER_SQL, [
      u.employee_id,
      u.name,
      u.email,
      hash,
      u.role,
      u.manager_id,
      u.project_id,
      u.department_code ?? '10000',
      u.status ?? 'ACTIVE',
      u.shift_rule ?? 'CR1',
      'EMEA',
      u.hire_date ?? addDays(today, -400),
    ]);
  }

  const adminId = await addUser({
    employee_id: 'PLS0000001',
    name: 'Systems Administrator',
    email: 'admin@konecta.example',
    role: 'ADMIN',
    manager_id: null,
    project_id: null,
  });

  const omId = await addUser({
    employee_id: 'OM0000010',
    name: 'Nadia Farouk',
    email: 'nadia.farouk@konecta.example',
    role: 'OPS_MANAGER',
    manager_id: adminId,
    project_id: 'A123',
  });

  const tlNightId = await addUser({
    employee_id: 'TL0000101',
    name: 'Youssef Adel',
    email: 'youssef.adel@konecta.example',
    role: 'TEAM_LEADER',
    manager_id: omId,
    project_id: 'A123',
  });

  const tlDayId = await addUser({
    employee_id: 'TL0000102',
    name: 'Mariam Saleh',
    email: 'mariam.saleh@konecta.example',
    role: 'TEAM_LEADER',
    manager_id: omId,
    project_id: 'A123',
    shift_rule: 'CR2',
  });

  const trainerId = await addUser({
    employee_id: 'TR0000201',
    name: 'Omar Hassan',
    email: 'omar.hassan@konecta.example',
    role: 'TRAINER',
    manager_id: omId,
    project_id: 'A123',
  });

  const nightAdvisorNames = [
    'Layla Mahmoud',
    'Karim Fouad',
    'Sara Nabil',
    'Hassan Tarek',
    'Dina Ashraf',
    'Amir Zaki',
  ];
  // Sequential rather than Promise.all: the ids are assigned in list order, and
  // the seed reads better when Layla is always AD0001101.
  const nightAdvisors: number[] = [];
  for (const [i, name] of nightAdvisorNames.entries()) {
    nightAdvisors.push(
      await addUser({
          employee_id: `AD000${1101 + i}`,
        name,
        email: emailFor(name),
        role: 'ADVISOR',
        manager_id: tlNightId,
        project_id: 'A123',
        shift_rule: i === 5 ? 'CR3' : 'CR1',
      }),
    );
  }

  const dayAdvisors: number[] = [];
  for (const [i, name] of ['Yara Samir', 'Mostafa Gamal', 'Nour Ibrahim', 'Rami Adel'].entries()) {
    dayAdvisors.push(
      await addUser({
        employee_id: `AD000${1201 + i}`,
        name,
        email: emailFor(name),
        role: 'ADVISOR',
        manager_id: tlDayId,
        project_id: 'A123',
        shift_rule: 'CR2',
      }),
    );
  }

  const newHires: number[] = [];
  for (const [i, name] of ['Salma Reda', 'Tamer Wael'].entries()) {
    newHires.push(
      await addUser({
        employee_id: `AD000${1301 + i}`,
        name,
        email: emailFor(name),
        role: 'ADVISOR',
        manager_id: trainerId,
        project_id: 'A123',
        hire_date: addDays(today, -9),
      }),
    );
  }

  // The advisor whose week the training scenarios are built around.
  const focusId = nightAdvisors[0];

  // -------------------------------------------------------- shift rule change
  const RULE_SQL =
    'INSERT INTO shift_rule_changes (user_id, shift_rule, effective_date, created_by) VALUES (?, ?, ?, ?)';
  // Audited as well as stored, exactly as the route does it. Writing straight
  // to the table skipped the audit and left the Rules Log empty on a fresh
  // install — a screen whose whole job is showing a history opening on nothing
  // teaches people it is broken.
  const ruleChange = async (userId: number, rule: string, effective: string, actorId: number) => {
    await db.run(RULE_SQL, [userId, rule, effective, actorId]);
    const who = await db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [userId]);
    await audit(actorId, 'shift_rule', userId, 'CHANGE', {
      shiftRule: rule,
      effectiveDate: effective,
      subject: who?.name ?? `#${userId}`,
    });
  };
  await ruleChange(nightAdvisors[1], 'CR2', addDays(today, 14), tlNightId);
  // One already in force and one pending, so the history reads as a history.
  await ruleChange(dayAdvisors[0], 'CR2', addDays(today, -30), tlDayId);
  await ruleChange(dayAdvisors[0], 'CR3', addDays(today, 21), tlDayId);

  const FROM = -14;
  // Schedules are published two days ahead; the forecast runs a week out. The
  // gap between them is deliberate — it is what the planner fills, and what
  // gives auto-scheduling something to actually do.
  // Far enough forward to carry a whole unpublished week. The next week being
  // a draft is the state the publish flow exists for, and a seed that only
  // ever shows published days would hide the feature entirely.
  const TO = 9;
  const DRAFT_FROM = 3;

  for (let offset = FROM; offset <= TO; offset++) {
    const date = addDays(today, offset);
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    const weekend = dow === 5 || dow === 6; // Friday & Saturday weekend

    // A contact centre does not close at the weekend, it runs thinner — and a
    // seed that empties the roster on Friday and Saturday means the live board
    // is blank for two days in seven, which reads as a broken screen rather
    // than a quiet one. Roughly the first half of each team covers weekends,
    // on rotation so it is not always the same people.
    const weekendCrew = new Set([
      ...nightAdvisors.filter((_, i) => (i + Math.abs(offset)) % 2 === 0),
      ...dayAdvisors.filter((_, i) => (i + Math.abs(offset)) % 2 === 0),
    ]);

    for (const userId of [...nightAdvisors, ...dayAdvisors, ...newHires]) {
      const night = nightAdvisors.includes(userId);
      const isNewHire = newHires.includes(userId);
      if (weekend && !isNewHire && !weekendCrew.has(userId)) continue;
      if (isNewHire && offset < -9) continue;

      const template = night ? NIGHT_SHIFT : DAY_SHIFT;
      const endTime = night ? NIGHT_END : DAY_END;

      const rows = template.map((r) => ({
        startAt: stamp(date, r.time),
        activityKey: r.activityKey,
      }));

      // New hires are in class rather than on the phones for their first week.
      const shiftRows = isNewHire
        ? [
            { startAt: stamp(date, '09:00'), activityKey: 'SHIFT_START' as ScheduleActivityKey },
            { startAt: stamp(date, '09:05'), activityKey: 'TRAINING' as ScheduleActivityKey },
            { startAt: stamp(date, '13:00'), activityKey: 'LUNCH' as ScheduleActivityKey },
            { startAt: stamp(date, '13:30'), activityKey: 'TRAINING' as ScheduleActivityKey },
          ]
        : rows;

      const shift: ScheduleShift = {
        shiftNo: 1,
        rows: shiftRows,
        endAt: stamp(date, isNewHire ? '17:00' : endTime),
      };

      await saveShifts({
        userId,
        date,
        shifts: [shift],
        actorId: adminId,
        source: 'IEX',
        status: offset >= DRAFT_FROM ? 'DRAFT' : 'PUBLISHED',
      });

      if (offset > 0) continue; // nothing has been punched in the future

      // Today's punches are emitted only up to the current moment, so a shift
      // that is part way through looks part way through rather than abandoned.
      await seedPunches({
        userId,
        date,
        night,
        isNewHire,
        isFocus: userId === focusId,
        offset,
        notAfter: offset === 0 ? nowStamp() : null,
      });
    }
  }

  // ---------------------------------------------- generate the resulting cards
  for (let offset = FROM; offset <= 0; offset++) {
    const date = addDays(today, offset);
    for (const userId of [...nightAdvisors, ...dayAdvisors, ...newHires]) {
      await generateTimecard({ userId, date, actorId: adminId, now: nowStamp() });
    }
  }

  // Approve everything older than five days so the summary is not a wall of red.
  await db.run(
    `UPDATE timecards SET approved = 1, approved_by = ?, approved_at = ?
     WHERE payroll_date < ? AND in_progress = 0`,
    [tlNightId, nowStamp(), addDays(today, -5)],
  );

  // ------------------------------------------------------------ payroll period
  const periodStart = addDays(today, -28);
  const periodEnd = addDays(today, -14);
  const PERIOD_SQL = 'INSERT INTO payroll_periods (region, start_date, end_date, cutoff_at) VALUES (?, ?, ?, ?)';
  await db.run(PERIOD_SQL, ['EMEA', periodStart, periodEnd, `${addDays(periodEnd, 1)} 23:59`]);
  await db.run(PERIOD_SQL, [
    'EMEA',
    addDays(today, -13),
    addDays(today, 1),
    `${addDays(today, 2)} 23:59`,
  ]);

  await runPayroll({ region: 'EMEA', start: periodStart, end: periodEnd, actorId: adminId });

  // ------------------------------------------------------------------ accruals
  const ACCRUAL_SQL = 'INSERT INTO accruals (user_id, accrual_type, balance_hours, as_of) VALUES (?, ?, ?, ?)';
  for (const [i, userId] of [...nightAdvisors, ...dayAdvisors, ...newHires].entries()) {
    await db.run(ACCRUAL_SQL, [userId, 'VACATION', 40 + i * 3.5, today]);
    await db.run(ACCRUAL_SQL, [userId, 'SICK', 16 + (i % 4) * 4, today]);
  }

  await db.run(
    `INSERT INTO time_off_requests (user_id, accrual_type, start_date, end_date, hours, status, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [nightAdvisors[2], 'VACATION', addDays(today, 21), addDays(today, 23), 24, 'PENDING', 'Family event'],
  );
  const TOR_DECIDED = `INSERT INTO time_off_requests (user_id, accrual_type, start_date, end_date, hours, status, reason, decided_by, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await db.run(TOR_DECIDED, [
    dayAdvisors[0],
    'VACATION',
    addDays(today, 30),
    addDays(today, 31),
    16,
    'APPROVED',
    'Annual leave',
    tlDayId,
    nowStamp(),
  ]);
  // Sick leave taken retrospectively, unpaid leave declined for coverage, and a
  // second pending request — between them the screen shows every path a
  // request can take.
  await db.run(TOR_DECIDED, [
    nightAdvisors[4],
    'SICK',
    addDays(today, -8),
    addDays(today, -8),
    8,
    'APPROVED',
    'Called in sick',
    tlNightId,
    nowStamp(),
  ]);
  await db.run(TOR_DECIDED, [
    dayAdvisors[3],
    'UNPAID',
    addDays(today, 9),
    addDays(today, 11),
    24,
    'DECLINED',
    'Extended trip — declined, week already short',
    tlDayId,
    nowStamp(),
  ]);
  await db.run(
    `INSERT INTO time_off_requests (user_id, accrual_type, start_date, end_date, hours, status, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [dayAdvisors[2], 'VACATION', addDays(today, 17), addDays(today, 18), 16, 'PENDING', 'Long weekend'],
  );

  // -------------------------------------------------------- groups & delegation
  const groupId = await db.insert('INSERT INTO groups (name, type, owner_id) VALUES (?, ?, ?)', [
    'Night Coverage',
    'CUSTOM',
    tlNightId,
  ]);
  for (const userId of nightAdvisors.slice(0, 3)) {
    await db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, userId]);
  }

  const dayGroupId = await db.insert('INSERT INTO groups (name, type, owner_id) VALUES (?, ?, ?)', [
    'Weekend Cover',
    'CUSTOM',
    tlDayId,
  ]);
  for (const userId of dayAdvisors.slice(0, 2)) {
    await db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', [dayGroupId, userId]);
  }

  await db.run('INSERT INTO alternates (user_id, alternate_user_id) VALUES (?, ?)', [tlDayId, tlNightId]);

  // ------------------------------------------------------------------ messages
  const MESSAGE_SQL = 'INSERT INTO messages (user_id, subject, body, severity) VALUES (?, ?, ?, ?)';
  await db.run(MESSAGE_SQL, [
    tlNightId,
    'Timecards awaiting approval',
    'You have unapproved timecards inside your three day edit window. Review and approve them before the payroll cut-off.',
    'WARN',
  ]);
  await db.run(MESSAGE_SQL, [
    tlNightId,
    'Exception review',
    'Layla Mahmoud has a Long Lunch and a Late on her card. Confirm the reason before approving.',
    'WARN',
  ]);
  await db.run(MESSAGE_SQL, [
    focusId,
    'Welcome to Konecta Pulse',
    'Clock on from the Web Clock when your shift starts. You can only clock on inside your scheduled window.',
    'INFO',
  ]);
  await db.run(MESSAGE_SQL, [
    omId,
    'Payroll period closed',
    `Payroll has run for ${periodStart} to ${periodEnd}. Edits to that period are now post-payroll corrections.`,
    'INFO',
  ]);

  // Every role should find something waiting when they first sign in — an empty
  // notification centre teaches people it is not worth checking.
  await db.run(MESSAGE_SQL, [
    tlDayId,
    'Swap waiting on you',
    'Two of your advisors have agreed a swap for next week. It needs your approval before either schedule moves.',
    'INFO',
  ]);
  await db.run(MESSAGE_SQL, [
    tlDayId,
    'Time off request',
    'A vacation request is pending for a week that is already short on cover. Check the day before approving.',
    'WARN',
  ]);
  await db.run(MESSAGE_SQL, [
    trainerId,
    'New starters clocking in',
    'Your class is on their first week. Trainee cards usually need correcting for the first day or two — you have a six day window.',
    'INFO',
  ]);
  await db.run(MESSAGE_SQL, [
    omId,
    'Coverage gap next week',
    'The forecast asks for more than the published roster covers on several evening intervals. Auto-schedule can draft against it.',
    'WARN',
  ]);
  await db.run(MESSAGE_SQL, [
    adminId,
    'Welcome',
    'You can see every project and team, and the full audit trail. Day-to-day corrections are better made by the supervisor who owns the team.',
    'INFO',
  ]);
  await db.run(MESSAGE_SQL, [
    dayAdvisors[1],
    'Extra hours awarded',
    'You were awarded the month-end backlog block. It is on your schedule, so you can clock on for it.',
    'INFO',
  ]);
  await db.run(MESSAGE_SQL, [
    nightAdvisors[2],
    'Swap approved',
    'Your shift swap went through. Check My Shifts — your working days have changed.',
    'INFO',
  ]);

  // ------------------------------------------------------- forecast & planning
  await db.run(
    'INSERT INTO forecast_settings (project_id, service_goal, target_seconds, shrinkage) VALUES (?, ?, ?, ?)',
    ['A123', 0.8, 20, 0.3],
  );
  // The settings that every requirement is computed from, on the record with
  // everything else that changed the rules.
  await audit(omId, 'forecast', 'A123', 'SETTINGS', {
    serviceGoal: 0.8,
    targetSeconds: 20,
    shrinkage: 0.3,
  });

  // A believable arrival curve: quiet overnight, a morning peak, a dip over
  // lunch, a second afternoon peak, tailing away through the evening.
  const CURVE = [
    0.05, 0.04, 0.03, 0.03, 0.02, 0.02, 0.02, 0.02, 0.03, 0.05, 0.1, 0.2, // 00:00-05:30
    0.35, 0.5, 0.68, 0.82, 0.92, 1.0, 0.98, 0.94, 0.9, 0.86, 0.8, 0.72, //   06:00-11:30
    0.62, 0.55, 0.52, 0.55, 0.63, 0.72, 0.82, 0.9, 0.95, 0.93, 0.88, 0.8, //  12:00-17:30
    0.7, 0.6, 0.5, 0.42, 0.34, 0.28, 0.22, 0.18, 0.14, 0.11, 0.08, 0.06, //   18:00-23:30
  ];

  await transact(async () => {
    for (let offset = -14; offset <= 7; offset++) {
      const date = addDays(today, offset);
      const dow = new Date(date + 'T00:00:00Z').getUTCDay();
      const weekend = dow === 5 || dow === 6;
      // Weekends run lighter, and each day carries a little natural variation.
      const dayFactor = (weekend ? 0.45 : 1) * (0.9 + ((Math.abs(offset) * 37) % 21) / 100);

      for (const [i, share] of CURVE.entries()) {
        const startTime = `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 === 0 ? '00' : '30'}`;
        // Scaled so the seeded roster roughly covers the curve: a day that is
        // mostly on plan with a few genuinely short intervals is what a planner
        // actually spends their time on.
        const volume = Math.round(share * 11 * dayFactor);
        const aht = 210 + ((i * 13) % 70); // handling time drifts through the day
        await db.run(
          'INSERT INTO forecast_intervals (project_id, date, start_time, volume, aht_seconds) VALUES (?, ?, ?, ?, ?)',
          ['A123', date, startTime, volume, aht],
        );
      }
    }
  });

  // ------------------------------------------------------------ self service
  const OFFER_SQL = `INSERT INTO extra_hours_offers (project_id, date, start_time, end_time, slots, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`;
  const offerId = await db.insert(OFFER_SQL, [
    'A123',
    addDays(today, 3),
    '18:00',
    '22:00',
    3,
    'Backlog clearance, evening cover',
    tlNightId,
  ]);
  const BID_SQL = 'INSERT INTO extra_hours_bids (offer_id, user_id) VALUES (?, ?)';
  await db.run(BID_SQL, [offerId, nightAdvisors[2]]);
  await db.run(BID_SQL, [offerId, nightAdvisors[3]]);
  await db.run(OFFER_SQL, [
    'A123',
    addDays(today, 6),
    '09:00',
    '13:00',
    2,
    'Saturday campaign support',
    tlDayId,
  ]);

  // One already settled, so the screen shows what an awarded offer looks like
  // rather than only open ones nobody has acted on.
  const filledId = await db.insert(OFFER_SQL, [
    'A123',
    addDays(today, -4),
    '17:00',
    '21:00',
    1,
    'Month-end backlog',
    tlNightId,
  ]);
  await db.run('INSERT INTO extra_hours_bids (offer_id, user_id, status) VALUES (?, ?, ?)', [
    filledId,
    dayAdvisors[1],
    'AWARDED',
  ]);
  await db.run('INSERT INTO extra_hours_bids (offer_id, user_id, status) VALUES (?, ?, ?)', [
    filledId,
    dayAdvisors[2],
    'PENDING',
  ]);
  await db.run('UPDATE extra_hours_offers SET status = ? WHERE id = ?', ['FILLED', filledId]);

  // Every state a swap can be in, so the screen shows the whole flow rather
  // than only the half that is still waiting on somebody.
  const SWAP_SQL = `INSERT INTO shift_swaps (requester_id, requester_date, counterparty_id, counterparty_date, reason, status, decided_by, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  await db.run(SWAP_SQL, [
    nightAdvisors[1],
    addDays(today, 2),
    nightAdvisors[4],
    addDays(today, 3),
    'Family commitment',
    'PENDING_PEER',
    null,
    null,
  ]);
  await db.run(SWAP_SQL, [
    dayAdvisors[1],
    addDays(today, 4),
    dayAdvisors[2],
    addDays(today, 5),
    'Medical appointment',
    'PENDING_APPROVAL',
    null,
    null,
  ]);
  await db.run(SWAP_SQL, [
    nightAdvisors[2],
    addDays(today, -6),
    nightAdvisors[3],
    addDays(today, -5),
    'Swapped to cover a college exam',
    'APPROVED',
    tlNightId,
    nowStamp(),
  ]);
  await db.run(SWAP_SQL, [
    dayAdvisors[3],
    addDays(today, -3),
    dayAdvisors[0],
    addDays(today, -2),
    'Wanted the Saturday off',
    'DECLINED',
    tlDayId,
    nowStamp(),
  ]);

  const counts = await db.get<any>(
      `SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM schedules) AS schedules,
              (SELECT COUNT(*) FROM punches) AS punches,
              (SELECT COUNT(*) FROM timecards) AS timecards,
              (SELECT COUNT(*) FROM timecard_rows) AS rows`,
  );

  say('Konecta Pulse seeded:', counts);
  say(`\nSign in with any of these — password for every account is "${PASSWORD}":`);
  say('  admin@konecta.example          System Administrator');
  say('  nadia.farouk@konecta.example   Operations Manager  (44 day edit window)');
  say('  youssef.adel@konecta.example   Team Leader, nights (3 day edit window)');
  say('  mariam.saleh@konecta.example   Team Leader, days');
  say('  omar.hassan@konecta.example    Trainer             (6 day edit window)');
  say('  layla.mahmoud@konecta.example  Advisor with the interesting week');

  return { seeded: true };
}

function emailFor(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@konecta.example`;
}

/**
 * Punch a day for one advisor. Most days are unremarkable; the focus advisor
 * gets a scripted week of problems so every exception path has real data behind
 * it on first launch.
 */
async function seedPunches(params: {
  userId: number;
  date: DateStr;
  night: boolean;
  isNewHire: boolean;
  isFocus: boolean;
  offset: number;
  /** When set, punches later than this instant are not emitted. */
  notAfter: string | null;
}) {
  const { userId, date, night, isNewHire, isFocus, offset, notAfter } = params;

  // Collected rather than written one at a time: a fortnight of punches for a
  // whole roster is thousands of inserts, and one statement per day beats one
  // per punch by an order of magnitude over a network.
  const pending: unknown[][] = [];
  const punch = (day: DateStr, time: string, type: string, activity: string | null) => {
    const at = stamp(day, time);
    if (notAfter && at > notAfter) return;
    pending.push([userId, at, type, activity, 'WEB_CLOCK']);
  };

  const next = addDays(date, 1);

  if (isNewHire) {
    punch(date, '08:58', 'ON', '15-001');
    punch(date, '13:02', 'CHANGE', '99-001');
    punch(date, '13:31', 'CHANGE', '15-001');
    punch(date, '17:00', 'OFF', null);
    return;
  }

  // The focus advisor's scripted week.
  if (isFocus && offset === -2) {
    // Late on, break taken an hour early, unscheduled CE training, a two minute
    // stray coaching punch, a meal that overran, and an early departure.
    punch(date, '23:05', 'ON', '01-001');
    punch(date, '23:06', 'CHANGE', '05-001');
    punch(date, '23:22', 'CHANGE', '01-001');
    punch(next, '01:00', 'CHANGE', '26-001');
    punch(next, '01:15', 'CHANGE', '01-001');
    punch(next, '02:30', 'CHANGE', '15-002');
    punch(next, '02:57', 'CHANGE', '01-001');
    punch(next, '03:00', 'CHANGE', '99-001');
    punch(next, '03:40', 'CHANGE', '16-001');
    punch(next, '03:42', 'CHANGE', '01-001');
    punch(next, '05:00', 'CHANGE', '26-001');
    punch(next, '05:15', 'CHANGE', '01-001');
    punch(next, '07:22', 'OFF', null);
    return;
  }

  if (isFocus && offset === -3) {
    // Forgot to clock off: the card is completed with an assumed off.
    punch(date, '22:58', 'ON', '01-001');
    punch(next, '01:01', 'CHANGE', '26-001');
    punch(next, '01:16', 'CHANGE', '01-001');
    punch(next, '03:00', 'CHANGE', '99-001');
    punch(next, '03:29', 'CHANGE', '01-001');
    return;
  }

  if (isFocus && offset === -6) {
    return; // no call no show
  }

  if (isFocus && offset === -4) {
    // Extra hours picked up at the end of the shift.
    punch(date, '22:59', 'ON', '01-001');
    punch(next, '01:00', 'CHANGE', '26-001');
    punch(next, '01:15', 'CHANGE', '01-001');
    punch(next, '03:00', 'CHANGE', '99-001');
    punch(next, '03:30', 'CHANGE', '01-001');
    punch(next, '06:15', 'CHANGE', '26-001');
    punch(next, '06:30', 'CHANGE', '01-001');
    punch(next, '07:30', 'CHANGE', '07-001');
    punch(next, '09:30', 'OFF', null);
    return;
  }

  // Everyone else works to plan. Most people come back from breaks on time, so
  // the exceptions that do appear are worth a supervisor's attention rather
  // than being background noise on every card.
  const seed = userId * 7 + Math.abs(offset) * 13;
  const startDrift = (seed % 5) - 2; // -2..+2 minutes around the scheduled start
  const overrun = seed % 9 === 0 ? 6 : 0; // an occasional genuine overrun
  const earlyOff = seed % 11 === 0 ? -6 : 0; // an occasional early departure

  const shiftStart = night ? '23:00' : '09:00';
  const start = shiftTime(shiftStart, startDrift);

  if (night) {
    punch(date, start, 'ON', '01-001');
    punch(next, '01:00', 'CHANGE', '26-001');
    punch(next, '01:15', 'CHANGE', '01-001');
    punch(next, '03:00', 'CHANGE', '99-001');
    punch(next, shiftTime('03:30', overrun), 'CHANGE', '01-001');
    punch(next, '06:15', 'CHANGE', '26-001');
    punch(next, '06:30', 'CHANGE', '01-001');
    punch(next, shiftTime('07:30', earlyOff), 'OFF', null);
  } else {
    punch(date, start, 'ON', '01-001');
    punch(date, '11:00', 'CHANGE', '26-001');
    punch(date, '11:15', 'CHANGE', '01-001');
    punch(date, '13:00', 'CHANGE', '99-001');
    punch(date, shiftTime('13:30', overrun), 'CHANGE', '01-001');
    punch(date, '15:30', 'CHANGE', '26-001');
    punch(date, '15:45', 'CHANGE', '01-001');
    punch(date, shiftTime('17:30', earlyOff), 'OFF', null);
  }

  if (pending.length === 0) return;
  const values = pending.map(() => '(?, ?, ?, ?, ?)').join(', ');
  await db.run(
    `INSERT INTO punches (user_id, at, type, activity, source) VALUES ${values}`,
    pending.flat(),
  );
}

function shiftTime(time: string, deltaMinutes: number): string {
  const [h, m] = time.split(':').map(Number);
  let total = h * 60 + m + deltaMinutes;
  total = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Run directly (`npm run seed`) rather than when imported by the server.
//
// Wrapped in an async function rather than using top-level await: this module
// is bundled into a CommonJS serverless function, and CJS has no top-level
// await at all — the build fails outright rather than degrading.
if (process.argv[1] && /seed\.(ts|js)$/.test(process.argv[1])) {
  void (async () => {
    try {
      await ensureSchema();
      await seed({ force: process.argv.includes('--force') });
      await db.close();
    } catch (err) {
      console.error('Seeding failed:', err);
      process.exit(1);
    }
  })();
}
