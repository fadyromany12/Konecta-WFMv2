/**
 * Schema for Konecta Pulse.
 *
 * All instants are text `YYYY-MM-DD HH:MM` and all dates text `YYYY-MM-DD`;
 * see domain/time.ts for why. Storing them as text rather than as timestamps is
 * what makes this schema portable almost unchanged — there is no timezone for
 * two databases to disagree about.
 *
 * Written once in SQLite's dialect and translated for Postgres by `schemaFor`
 * below. Only three things genuinely differ, and keeping one schema means a
 * column can never be added to one database and forgotten in the other.
 */

const CANONICAL = `

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
  id              {{ID}},
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
  created_at      TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id);

-- Future-dated shift rule changes. A rule change may only be entered for a
-- future effective date so that it cannot rewrite time already worked.
CREATE TABLE IF NOT EXISTS shift_rule_changes (
  id             {{ID}},
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_rule     TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_shift_rule_changes_user ON shift_rule_changes(user_id, effective_date);

CREATE TABLE IF NOT EXISTS schedules (
  id           {{ID}},
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payroll_date TEXT NOT NULL,
  shift_no     INTEGER NOT NULL DEFAULT 1,
  end_at       TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'PULSE',
  updated_at   TEXT NOT NULL DEFAULT {{NOW}},
  UNIQUE (user_id, payroll_date, shift_no)
);
CREATE INDEX IF NOT EXISTS idx_schedules_user_date ON schedules(user_id, payroll_date);

CREATE TABLE IF NOT EXISTS schedule_rows (
  id           {{ID}},
  schedule_id  INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  start_at     TEXT NOT NULL,
  activity_key TEXT NOT NULL,
  sort_order   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_rows_schedule ON schedule_rows(schedule_id, sort_order);

CREATE TABLE IF NOT EXISTS punches (
  id         {{ID}},
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  type       TEXT NOT NULL,
  activity   TEXT,
  source     TEXT NOT NULL DEFAULT 'WEB_CLOCK',
  created_at TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_punches_user_at ON punches(user_id, at);

CREATE TABLE IF NOT EXISTS timecards (
  id                  {{ID}},
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
  updated_at          TEXT NOT NULL DEFAULT {{NOW}},
  UNIQUE (user_id, payroll_date, shift_no)
);
CREATE INDEX IF NOT EXISTS idx_timecards_user_date ON timecards(user_id, payroll_date);

CREATE TABLE IF NOT EXISTS timecard_rows (
  id          {{ID}},
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
  id         {{ID}},
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  owner_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT {{NOW}},
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
  assigned_at       TEXT NOT NULL DEFAULT {{NOW}}
);

CREATE TABLE IF NOT EXISTS accruals (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accrual_type  TEXT NOT NULL,
  balance_hours REAL NOT NULL DEFAULT 0,
  as_of         TEXT NOT NULL,
  PRIMARY KEY (user_id, accrual_type)
);

CREATE TABLE IF NOT EXISTS time_off_requests (
  id           {{ID}},
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accrual_type TEXT NOT NULL,
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  hours        REAL NOT NULL,
  status       TEXT NOT NULL DEFAULT 'PENDING',
  reason       TEXT,
  decided_by   INTEGER REFERENCES users(id),
  decided_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_tor_user ON time_off_requests(user_id, start_date);

-- Every change to a schedule, timecard or approval is recorded. These are
-- financial records, so who changed what and when is not optional.
CREATE TABLE IF NOT EXISTS audit_log (
  id         {{ID}},
  at         TEXT NOT NULL DEFAULT {{NOW}},
  actor_id   INTEGER REFERENCES users(id),
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

CREATE TABLE IF NOT EXISTS messages (
  id         {{ID}},
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'INFO',
  read_flag  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, read_flag);

-- Forecast volumes per half hour. Required headcount is derived from these by
-- the Erlang model rather than stored, so changing the service goal or
-- shrinkage re-plans the day without a rewrite.
CREATE TABLE IF NOT EXISTS forecast_intervals (
  id          {{ID}},
  project_id  TEXT NOT NULL REFERENCES projects(activity_id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  start_time  TEXT NOT NULL,
  volume      REAL NOT NULL DEFAULT 0,
  aht_seconds INTEGER NOT NULL DEFAULT 240,
  updated_at  TEXT NOT NULL DEFAULT {{NOW}},
  UNIQUE (project_id, date, start_time)
);
CREATE INDEX IF NOT EXISTS idx_forecast_project_date ON forecast_intervals(project_id, date);

-- Service level promise and planning assumptions, per project.
CREATE TABLE IF NOT EXISTS forecast_settings (
  project_id     TEXT PRIMARY KEY REFERENCES projects(activity_id) ON DELETE CASCADE,
  service_goal   REAL NOT NULL DEFAULT 0.8,
  target_seconds INTEGER NOT NULL DEFAULT 20,
  shrinkage      REAL NOT NULL DEFAULT 0.3
);

-- Advisors trading shifts with each other. Both sides and a supervisor have to
-- agree, so the record carries the state of each.
CREATE TABLE IF NOT EXISTS shift_swaps (
  id                {{ID}},
  requester_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_date    TEXT NOT NULL,
  counterparty_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  counterparty_date TEXT NOT NULL,
  reason            TEXT,
  -- PENDING_PEER -> PENDING_APPROVAL -> APPROVED | DECLINED
  status            TEXT NOT NULL DEFAULT 'PENDING_PEER',
  decided_by        INTEGER REFERENCES users(id),
  decided_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_swaps_requester ON shift_swaps(requester_id);
CREATE INDEX IF NOT EXISTS idx_swaps_counterparty ON shift_swaps(counterparty_id);

-- Extra hours offered out to a team, and the advisors putting their hand up.
CREATE TABLE IF NOT EXISTS extra_hours_offers (
  id           {{ID}},
  project_id   TEXT NOT NULL REFERENCES projects(activity_id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  start_time   TEXT NOT NULL,
  end_time     TEXT NOT NULL,
  slots        INTEGER NOT NULL DEFAULT 1,
  note         TEXT,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'OPEN',
  created_at   TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_offers_date ON extra_hours_offers(date);

CREATE TABLE IF NOT EXISTS extra_hours_bids (
  id         {{ID}},
  offer_id   INTEGER NOT NULL REFERENCES extra_hours_offers(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL DEFAULT {{NOW}},
  UNIQUE (offer_id, user_id)
);

-- Payroll periods carry the cut-off after which edits miss the run entirely.
CREATE TABLE IF NOT EXISTS payroll_periods (
  id         {{ID}},
  region     TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date   TEXT NOT NULL,
  cutoff_at  TEXT NOT NULL,
  run_at     TEXT,
  UNIQUE (region, start_date)
);
`;

/**
 * The three real differences.
 *
 * `AUTOINCREMENT` is SQLite's spelling of an identity column. `REAL` is a
 * 4-byte float in Postgres, which is too coarse for an accrual balance, so it
 * becomes double precision there. And the default timestamp has to produce the
 * same naive `YYYY-MM-DD HH:MM:SS` text in both, or rows written by the
 * database would not sort against rows written by the application.
 */
const DIALECTS = {
  sqlite: {
    ID: 'INTEGER PRIMARY KEY AUTOINCREMENT',
    NOW: "(datetime('now'))",
  },
  postgres: {
    ID: 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY',
    NOW: "(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))",
  },
} as const;

export function schemaFor(dialect: 'sqlite' | 'postgres'): string {
  const tokens = DIALECTS[dialect];
  let sql = CANONICAL.replace(/\{\{ID\}\}/g, tokens.ID).replace(/\{\{NOW\}\}/g, tokens.NOW);
  if (dialect === 'postgres') {
    // float4 loses cents on an hours balance; float8 does not.
    sql = sql.replace(/\bREAL\b/g, 'DOUBLE PRECISION');
  }
  return sql;
}
