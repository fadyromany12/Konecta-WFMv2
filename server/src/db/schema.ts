/**
 * Schema for Konecta Pulse.
 *
 * All instants are text `YYYY-MM-DD HH:MM` and all dates text `YYYY-MM-DD`;
 * see domain/time.ts for why. SQLite is used so the whole system runs from a
 * single file with no external services to stand up.
 */

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Projects are identified by a 4-6 character Activity ID that is a subset of a
-- Financial Number: the same project run from two sites shares the FN but has a
-- distinct Activity ID per site, which is what scopes visibility and codes.
CREATE TABLE IF NOT EXISTS projects (
  activity_id      TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  financial_number TEXT NOT NULL,
  site             TEXT NOT NULL,
  region           TEXT NOT NULL DEFAULT 'EMEA'
);

-- Department codes a project is configured for. An employee whose department is
-- not configured for their project gets no timekeeping activities at all.
CREATE TABLE IF NOT EXISTS project_departments (
  activity_id     TEXT NOT NULL REFERENCES projects(activity_id) ON DELETE CASCADE,
  department_code TEXT NOT NULL,
  PRIMARY KEY (activity_id, department_code)
);

CREATE TABLE IF NOT EXISTS project_activities (
  activity_id   TEXT NOT NULL REFERENCES projects(activity_id) ON DELETE CASCADE,
  activity_code TEXT NOT NULL,
  PRIMARY KEY (activity_id, activity_code)
);

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id     TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL,
  manager_id      INTEGER REFERENCES users(id),
  project_id      TEXT REFERENCES projects(activity_id),
  department_code TEXT NOT NULL DEFAULT '10000',
  -- Mirrors the HR system. A non-ACTIVE employee cannot sign in, exactly as a
  -- leave or termination in the HR feed blocks access.
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  shift_rule      TEXT NOT NULL DEFAULT 'CR1',
  region          TEXT NOT NULL DEFAULT 'EMEA',
  hire_date       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id);

-- Future-dated shift rule changes. A rule change may only be entered for a
-- future effective date so that it cannot rewrite time already worked.
CREATE TABLE IF NOT EXISTS shift_rule_changes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_rule     TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shift_rule_changes_user ON shift_rule_changes(user_id, effective_date);

CREATE TABLE IF NOT EXISTS schedules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payroll_date TEXT NOT NULL,
  shift_no     INTEGER NOT NULL DEFAULT 1,
  end_at       TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'PULSE',
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, payroll_date, shift_no)
);
CREATE INDEX IF NOT EXISTS idx_schedules_user_date ON schedules(user_id, payroll_date);

CREATE TABLE IF NOT EXISTS schedule_rows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id  INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  start_at     TEXT NOT NULL,
  activity_key TEXT NOT NULL,
  sort_order   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_rows_schedule ON schedule_rows(schedule_id, sort_order);

CREATE TABLE IF NOT EXISTS punches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  type       TEXT NOT NULL,
  activity   TEXT,
  source     TEXT NOT NULL DEFAULT 'WEB_CLOCK',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_punches_user_at ON punches(user_id, at);

CREATE TABLE IF NOT EXISTS timecards (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payroll_date        TEXT NOT NULL,
  shift_no            INTEGER NOT NULL DEFAULT 1,
  approved            INTEGER NOT NULL DEFAULT 0,
  approved_by         INTEGER REFERENCES users(id),
  approved_at         TEXT,
  -- Set when payroll runs over the period containing this card. Any later edit
  -- is a post-payroll correction.
  protect_date        TEXT,
  manual_check_status TEXT NOT NULL DEFAULT 'NONE',
  assumed_off         INTEGER NOT NULL DEFAULT 0,
  in_progress         INTEGER NOT NULL DEFAULT 0,
  -- Once a human has touched a card the punch engine stops regenerating it,
  -- so an automatic rebuild can never silently discard a supervisor's edit.
  edited              INTEGER NOT NULL DEFAULT 0,
  notes               TEXT,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, payroll_date, shift_no)
);
CREATE INDEX IF NOT EXISTS idx_timecards_user_date ON timecards(user_id, payroll_date);

CREATE TABLE IF NOT EXISTS timecard_rows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timecard_id INTEGER NOT NULL REFERENCES timecards(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  project     TEXT NOT NULL,
  activity    TEXT NOT NULL,
  start_at    TEXT NOT NULL,
  end_at      TEXT NOT NULL,
  sort_order  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timecard_rows_card ON timecard_rows(timecard_id, sort_order);

-- System groups are generated from the reporting hierarchy and prefixed '--'.
-- Custom groups are created by a user and prefixed '-'. Delegation groups are
-- prefixed 'ALT_' and appear in the delegate's list.
CREATE TABLE IF NOT EXISTS groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  owner_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (name, owner_id)
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

-- A supervisor may delegate their team to exactly one alternate at a time.
CREATE TABLE IF NOT EXISTS alternates (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  alternate_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accruals (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accrual_type  TEXT NOT NULL,
  balance_hours REAL NOT NULL DEFAULT 0,
  as_of         TEXT NOT NULL,
  PRIMARY KEY (user_id, accrual_type)
);

CREATE TABLE IF NOT EXISTS time_off_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accrual_type TEXT NOT NULL,
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  hours        REAL NOT NULL,
  status       TEXT NOT NULL DEFAULT 'PENDING',
  reason       TEXT,
  decided_by   INTEGER REFERENCES users(id),
  decided_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tor_user ON time_off_requests(user_id, start_date);

-- Every change to a schedule, timecard or approval is recorded. These are
-- financial records, so who changed what and when is not optional.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  actor_id   INTEGER REFERENCES users(id),
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'INFO',
  read_flag  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, read_flag);

-- Payroll periods carry the cut-off after which edits miss the run entirely.
CREATE TABLE IF NOT EXISTS payroll_periods (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  region     TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date   TEXT NOT NULL,
  cutoff_at  TEXT NOT NULL,
  run_at     TEXT,
  UNIQUE (region, start_date)
);
`;
