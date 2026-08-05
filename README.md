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

**Home** — web clock and messages. Clock on, change activity, clock off.

**Time & Attendance** — Payroll Summary (a row per timecard, its codes, the approval
checkbox) and the timecard editor, which shows the payroll shift detail and the
scheduled shift side by side while you edit. Worked Calendar gives a month at a time.

**Scheduling** — the schedule editor (insert row above, delete row, add shift) and
Group Schedule Exceptions for dropping a team meeting across a whole group at once.
An exception that falls outside somebody's shift is skipped and reported rather than
silently moving their shift.

**Absence** — time off requests checked against accrued balances, and approvals.

**Admin** — Details of Who and custom groups, shift rules, alternate delegation, and
the audit trail. Groups prefixed `--` come from the reporting hierarchy, `-` are your
own, `ALT_` are delegated to you.

**Reports** — the Pulse Report (schedule against reality for one advisor and day,
with an adherence bar and the questions worth asking), the Non-Worked Exception
report, and a query tool with CSV export.

## Notes

The seed password is shared across demonstration accounts and the JWT secret falls
back to a development default — set `PULSE_SECRET` and issue real credentials before
this is put anywhere real. `PULSE_DB` overrides the database location.
