# Konecta Pulse

**P**lanning · **U**tilization · **L**abor · **S**cheduling · **E**xceptions

A workforce management tool for contact centre operations: scheduling, timekeeping,
attendance and reporting in one place. Advisors clock their time against activity
codes; supervisors review what actually happened against what was planned, correct
the exceptions, and approve the timecards that feed payroll and client billing.

Modelled on the eSTART operating model, rebuilt as a self-contained application.

---

## Running it

```bash
npm install
npm run seed      # build data/pulse.db with a fortnight of realistic data
npm run dev       # API on :4000, web on :5173
```

Open <http://localhost:5173>. Every demonstration account uses the password `pulse123`:

| Account | Role | Edit window |
| --- | --- | --- |
| `youssef.adel@konecta.example` | Team Leader (nights) | 3 days |
| `mariam.saleh@konecta.example` | Team Leader (days) | 3 days |
| `omar.hassan@konecta.example` | Trainer | 6 days |
| `nadia.farouk@konecta.example` | Operations Manager | 44 days |
| `admin@konecta.example` | System Administrator | unrestricted |
| `layla.mahmoud@konecta.example` | Advisor | none |

Sign in as Youssef Adel to see the supervisory screens. Layla Mahmoud's week is
seeded with the interesting problems: a late clock-on, a meal that overran, training
nobody scheduled, a shift with no clock-off, and a no call no show.

Other commands:

```bash
npm test          # domain rule tests
npm run typecheck # server + web
npm run build     # production build; the server then serves web/dist itself
npm run seed -- --force   # rebuild the database from scratch
```

## Deploying to Vercel

The repository is Vercel-ready. `api/index.ts` exports the Express app as a
serverless function, `vercel.json` routes `/api/*` to it and everything else to
the built SPA.

Either connect the repository at [vercel.com/new](https://vercel.com/new) and let
it deploy on push, or from a checkout:

```bash
npm i -g vercel
vercel --prod
```

The build does not care what the project's **Root Directory** is set to. Vercel
resolves `outputDirectory` and function paths relative to that setting, so a
Root Directory pointing at `server/` — which its monorepo detection may offer —
would normally hide `web/` and `api/` and nothing could be found. Instead of
depending on it, `scripts/vercel-build.sh` walks up to the repository root and
emits a complete [Build Output API v3](https://vercel.com/docs/build-output-api/v3)
directory into whichever directory Vercel started in:

```
.vercel/output/
  config.json              routes: /api/* to the function, then filesystem, then SPA
  static/                  the built front end
  functions/api.func/      the bundled Express app plus better-sqlite3's addon
```

That makes the deployment reproducible from any root, and it is also why
`vercel.json` is three lines — no `outputDirectory`, `functions` or `rewrites` to
keep in step, because the build states all of it directly.

Leave the dashboard's Build Command and Install Command overrides empty; anything
set there silently takes precedence over `vercel.json`.

**How data works there.** A serverless filesystem is read-only apart from `/tmp`,
and `/tmp` is neither shared between instances nor durable. So on Vercel the
database defaults to `:memory:` and each cold start seeds itself in about a
quarter of a second. That makes the deployment reproducible and free of external
dependencies, at the cost of edits living only as long as a warm instance —
right for a testing environment, not for real data. Point `PULSE_DB` at a file
for single-process hosting, or move to Postgres for anything durable.

**Set `PULSE_SECRET`.** Without it, session tokens are signed with the public
development fallback and the app warns on boot:

```bash
vercel env add PULSE_SECRET production
```

Demonstration accounts share one password, so treat any deployment as public.

## How it is put together

```
server/src/domain/     the rules, with no database or HTTP anywhere near them
server/src/services/   persistence and orchestration
server/src/routes/     the REST API
web/src/pages/         one file per tab
```

`server/src/domain` is the part worth reading first. It is pure functions over plain
data — payroll dates, edit windows, timecard validation, the punch engine, adherence
— which is why the test suite can cover the awkward cases directly.

## The rules it enforces

**Time is wall clock time.** Every instant is stored as a naive `YYYY-MM-DD HH:MM`
string, never a `Date` with a timezone. An advisor scheduled 23:00–07:30 works that
wall clock whatever daylight saving does underneath, and schedules, timecards and
payroll dates all stay in agreement.

**A shift belongs to one payroll date.** A shift crossing midnight has all of its
time associated with the date it started on. The card is refused if its paid time
starts on a different date to its payroll date — the check that catches a
time-shifted card before it reaches payroll.

**Rows are entered as times; the system decides the day.** Type `02:30` into a shift
that started at 23:00 and it lands on the following morning. Entry auto-inserts the
colon after two digits, so `0500` becomes `05:00` and the required leading zero
stops being a way to get it wrong.

**Edit windows are per role.** Team Leader 3 days, Trainer 6 (new hires often are
not in the system for their first days), Operations Manager 44. Past that the tool
refuses and says who to escalate to. A timecard is a financial document; late edits
miss the metric and billing cycles they feed.

**Payroll protection.** Running payroll stamps a protect date on every card in the
period. Editing inside a protected period is still allowed but becomes a post-payroll
correction, flagged as such, transferring on a later run — optionally as a manual
check.

**Codes and activities are paired.** Correcting a Long Lunch to Worked without also
moving the activity off the unpaid meal code leaves the advisor unpaid for the time
you just told them they would be paid for. That pairing is invisible on screen, so it
is checked on save.

**No gaps, no overlaps.** Delete a row and you must account for the time removed.
Both are refused with the exact size and position of the problem.

**Contiguous rows merge.** Rows sharing a code, project and activity are combined on
save. This is deliberate — a corrected row disappearing into its neighbours surprises
people who have not seen it before, so it is stated here and covered by a test.

**Clock on only when scheduled.** No schedule means no clocking on. Once on an unpaid
meal an advisor cannot return to a paid activity until the meal duration has elapsed.

**Shift rule changes are future-dated only**, so a rule change can never rewrite how
time already worked was judged.

**Everything is attributable.** Schedule edits, timecard edits, approvals, punches and
payroll runs all land in the audit log with an actor.

## What the punch engine does

Punches plus a schedule produce the first draft of a timecard, so supervisors review
exceptions rather than reconstructing shifts by hand:

- **LT** — clocked on after the scheduled start, beyond the shift rule's grace
- **LE** — clocked off early, beyond grace
- **LLU / LB** — meal or break split into the allowance plus the overrun, so only the
  excess needs correcting
- **NCS** — a scheduled shift that ended with no punches at all
- **assumed off** — no clock-off; the scheduled end is assumed and the card flagged
- **in progress** — the shift is still running, so the card is provisional

Anything it produces is editable. Once a human edits a card the engine stops
regenerating it, so an automatic rebuild can never discard a supervisor's work.
`Rebuild from punches` overrides that explicitly.

## The screens

**Dashboard** — for a supervisor, the intraday command centre: who is on right now,
who is late, live adherence, and today's cover against the forecast. For an advisor,
the web clock and their messages. It updates as things happen (see below) rather than
on a timer.

**Time & Attendance** — Payroll Summary (a row per timecard, its codes, the approval
checkbox) and the timecard editor, which shows the payroll shift detail and the
scheduled shift side by side while you edit. Worked Calendar gives a month at a time.

**Scheduling** — the schedule editor (insert row above, delete row, add shift),
Group Schedule Exceptions for dropping a team meeting across a whole group at once,
and Forecast & Coverage: contact volume in, required headcount out via Erlang C,
compared against what is actually rostered, with an auto-scheduler that drafts shifts
into the worst-covered intervals. An exception that falls outside somebody's shift is
skipped and reported rather than silently moving their shift.

**My Shifts** — time off requests checked against accrued balances, shift swaps
(both advisors agree, then a supervisor approves, and the approval is what actually
exchanges the schedules), and extra hours: supervisors post a block, advisors bid,
the supervisor awards. Awarding adds the shift, which is what lets them clock on.

**Admin** — Details of Who and custom groups, shift rules, alternate delegation, and
the audit trail. Groups prefixed `--` come from the reporting hierarchy, `-` are your
own, `ALT_` are delegated to you.

**Reports** — the Pulse Report (schedule against reality for one advisor and day,
with an adherence bar and the questions worth asking), Analytics (adherence trend,
exception mix, shrinkage by activity, and advisor scorecards sorted by exception
count), the Non-Worked Exception report, and a query tool with CSV export.

## Live updates, search and bulk approval

**Events are pushed, not polled.** `GET /api/events` is a server-sent event stream.
A punch, an approval, a schedule change or a swap is delivered to everyone entitled
to see it the moment it happens, and the screens that care re-read themselves. Who
is entitled is resolved once when the stream opens: an advisor only ever hears about
themselves, whatever else is going on.

The stream is a speed-up, not a dependency. Every live screen keeps a slow poll
underneath it, because the stream can fail for reasons the browser cannot see — a
buffering proxy, or a platform running more than one instance so the event is raised
somewhere the client is not connected. The dot under the notification bell is lit
only while the stream is genuinely open; when it is grey the app is on its timer.

**Notifications** are the durable half of the same idea: a late start, a swap waiting
on you, extra hours awarded, a schedule someone changed. A supervisor is not looking
at the screen at the moment an advisor clocks on late, so it has to still be there
afterwards.

**⌘K** (Ctrl-K) opens a command palette: any screen, any advisor by name or employee
ID — which lands you on their Pulse Report or schedule directly — plus the theme and
the guide.

**Approve N clean** on the Payroll Summary approves every timecard that nobody needed
to read. What counts as clean is decided by the server, not the screen, and it is
deliberately strict: any exception code, any validation error, an assumed clock-off,
a shift still running, an unfinished day, or a date payroll has already run for is
left behind with the reason shown. See `server/src/domain/bulkApproval.ts` — a card
wrongly left for a human costs five seconds; one wrongly swept into an approved
payroll run is somebody paid the wrong amount.

## Storage: SQLite or Postgres

The application runs on either, chosen entirely by environment. Nothing else
changes — the same build, the same code paths, the same behaviour.

```bash
# SQLite (default). Nothing to install, nothing to configure.
npm run seed -w @konecta-pulse/server
npm run dev

# Postgres. Set one variable and the app uses it instead.
export PULSE_DATABASE_URL="postgres://user:password@host:5432/pulse"
npm run seed -w @konecta-pulse/server   # creates the tables and the demo data
npm run dev
```

`DATABASE_URL` and `POSTGRES_URL` are read too, because that is what the hosted
providers set for you — so on Vercel, adding a Postgres integration is usually
the whole configuration step. The tables are created on first use and an empty
database seeds itself, so there is no migration command to remember.

**Why it matters.** With no `PULSE_DATABASE_URL`, a Vercel deployment stores
everything in memory: it seeds itself on cold start, and loses every punch,
edit and approval when the instance is recycled. That is fine for a demo and
wrong for anything else. It also means each instance holds its own copy of the
truth, so a live event raised on one is invisible to a client connected to
another. Postgres fixes both.

**What it costs.** The data layer is async — SQLite included, so there is only
one shape of calling code and a bug cannot be "works on SQLite, breaks on
Postgres". `server/src/db/` holds the two drivers behind one interface;
`server/src/domain/` never sees either, which is why the whole test suite was
unaffected by the port.

Verification for the port is a diff: the same twelve endpoints exercised against
both backends produce byte-identical JSON across ~13,000 lines of output, and
the seed produces identical row counts (17 users, 144 schedules, 768 punches,
129 timecards, 775 rows) on each.

| Variable | Default | What it does |
| --- | --- | --- |
| `PULSE_DATABASE_URL` | unset | Postgres connection string. Also `DATABASE_URL`, `POSTGRES_URL`. |
| `PULSE_DB` | `data/pulse.db` | SQLite file, or `:memory:`. Ignored when a Postgres URL is set. |
| `PULSE_DB_SSL` | auto | `off` disables TLS, `verify` demands a valid certificate chain. |
| `PULSE_DB_POOL` | 10 (1 on Vercel) | Maximum Postgres connections. |
| `PULSE_SECRET` | dev default | JWT signing secret. Set this anywhere real. |

## Notes

The seed password is shared across demonstration accounts and the JWT secret falls
back to a development default — set `PULSE_SECRET` and issue real credentials before
this is put anywhere real. `PULSE_DB` overrides the database location.

The event stream is the one route that accepts its token from the query string,
because `EventSource` cannot set request headers. That is worse than a header — URLs
reach access logs — so it is confined to that single read-only route rather than
allowed everywhere.

On Vercel the database defaults to `:memory:` and seeds itself on cold start, so the
hosted deployment needs no writable disk and no configuration. Set
`PULSE_DATABASE_URL` when the data needs to survive — see the storage section above.
