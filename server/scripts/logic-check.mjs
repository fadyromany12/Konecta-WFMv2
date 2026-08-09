/**
 * The logic pass: every endpoint and, more importantly, every refusal.
 *
 * The unit suite covers the rules as pure functions. This covers the wiring —
 * that the rule is actually reached through HTTP, by the right roles, against a
 * real database. Most of what it asserts is that something is *refused*: an
 * advisor reading a payroll summary, a card saved with a gap, a paid code on an
 * unpaid activity, a rule change dated yesterday, an approval on a shift still
 * running. Those are the paths that cost money when they quietly stop working.
 *
 * Run it against a server that is already up:
 *
 *     npm run dev                      # or node dist/index.js
 *     npm run check:logic              # defaults to http://localhost:4000/api
 *     BASE=https://host/api npm run check:logic
 *
 * It is deliberately not a vitest file. It needs a running server and a seeded
 * database, which is a different thing from a unit test and should not be able
 * to fail `npm test` because a port was busy.
 *
 * Dates are read from the seeded data rather than hard-coded, so it keeps
 * working tomorrow.
 */
const BASE = process.env.BASE ?? 'http://localhost:4000/api';
// The origin behind BASE. Hard-coding localhost:4000 here meant the page-load
// checks silently tested whichever server happened to be on that port rather
// than the one everything else was aimed at.
const ORIGIN = new URL(BASE).origin;

/** Dates relative to today, so this keeps working tomorrow. */
const day = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
/** A recent finished day, one outside a team leader's window, and the range. */
const RECENT = day(-3), OLD = day(-19), RANGE_START = day(-19), RANGE_END = day(0);
/** Comfortably beyond any edit window, for the future-dated rule change. */
const FUTURE = day(120);
/** One day on from an arbitrary date, for the shift-move checks. */
const addDay = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
let pass = 0, fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
}

async function call(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* html */ }
  return { status: res.status, body: json, raw: text };
}

const tok = async (email) =>
  (await call('POST', '/auth/login', null, { email, password: 'pulse123' })).body?.token;

const TL   = await tok('mariam.saleh@konecta.example');   // day team leader
const NTL  = await tok('youssef.adel@konecta.example');   // night team leader
const OM   = await tok('nadia.farouk@konecta.example');
const ADV  = await tok('layla.mahmoud@konecta.example');
const ADM  = await tok('admin@konecta.example');
const TRN  = await tok('omar.hassan@konecta.example');

console.log('=== AUTH & ACCESS ===');
check('bad password refused', (await call('POST','/auth/login',null,{email:'admin@konecta.example',password:'wrong'})).status === 401);
check('unknown user refused', (await call('POST','/auth/login',null,{email:'nobody@x.com',password:'pulse123'})).status === 401);
check('no token refused', (await call('GET','/clock',null)).status === 401);
check('garbage token refused', (await call('GET','/clock','not-a-token')).status === 401);
check('all six roles sign in', [TL,NTL,OM,ADV,ADM,TRN].every(Boolean));

console.log('=== ROLE BOUNDARIES ===');
check('advisor cannot read payroll summary', (await call('GET','/payroll/summary?start=2000-01-01&end=2100-01-01',ADV)).status === 403);
check('advisor cannot edit a schedule', (await call('PUT',`/schedules/6/${day(2)}`,ADV,{shifts:[]})).status === 403);
check('advisor cannot see the audit trail', (await call('GET','/admin/audit',ADV)).status === 403);
check('advisor cannot run payroll', (await call('POST','/payroll/run',ADV,{start:day(-7),end:day(-6)})).status === 403);
check('team leader cannot run payroll', (await call('POST','/payroll/run',TL,{start:day(-7),end:day(-6)})).status === 403);
const people = (await call('GET','/people',TL)).body.people;
const otherTeam = (await call('GET','/people',NTL)).body.people;
const foreign = otherTeam.find((p) => !people.some((q) => q.id === p.id));
if (foreign) {
  check("cannot view another team's timecard", (await call('GET',`/timecards/${foreign.id}/${day(-3)}`,TL)).status === 403);
} else check('teams overlap so cross-team check skipped', true);

// Peer privacy. `visibleUserIds` includes everybody under the same
// second-level manager so supervisors can cover for each other, and applying
// that to a record let one advisor read another's.
check('an advisor cannot read a peer timecard',
  (await call('GET',`/timecards/3/${RECENT}`,ADV)).status === 403);
check('an advisor cannot read a peer leave balance',
  (await call('GET','/absence/accruals?userId=3',ADV)).status === 403);
check('an advisor cannot read a peer schedule',
  (await call('GET',`/schedules/3?start=${RECENT}&end=${RECENT}`,ADV)).status === 403);
check('an advisor cannot read a peer personal history',
  (await call('GET','/history/3',ADV)).status === 403);
check('an advisor can still read their own',
  (await call('GET','/absence/accruals?userId=6',ADV)).status === 200);
check('a team leader still reads their team',
  (await call('GET',`/timecards/3/${RECENT}`,TL)).status === 200);

console.log('=== TIMECARD RULES ===');
const target = people.find((p) => p.role === 'ADVISOR');
const card = (await call('GET',`/timecards/${target.id}/${day(-3)}`,TL)).body;
check('timecard loads with a decision', !!card?.decision);
check('edit window reported', typeof card.decision.windowDays === 'number');
// Way outside a team leader's 3-day window.
const old = (await call('GET',`/timecards/${target.id}/${OLD}`,TL)).body;
check('old card outside TL window is refused', old?.decision?.allowed === false, JSON.stringify(old?.decision));
check('ops manager reaches further back', (await call('GET',`/timecards/${target.id}/${OLD}`,OM)).body?.decision?.allowed === true);
// Save with a gap should be refused.
const bad = await call('PUT',`/timecards/${target.id}/${RECENT}`,TL,{rows:[
  {code:'(W)',project:'A123',activity:'01-001',startAt:`${RECENT} 09:00`,endAt:`${RECENT} 10:00`},
  {code:'(W)',project:'A123',activity:'01-001',startAt:`${RECENT} 11:00`,endAt:`${RECENT} 12:00`},
]});
check('gap in a timecard refused', bad.status === 400, `status ${bad.status}`);
// Paid code on unpaid activity.
const unpaid = await call('PUT',`/timecards/${target.id}/${RECENT}`,TL,{rows:[
  {code:'(W)',project:'A123',activity:'99-001',startAt:`${RECENT} 09:00`,endAt:`${RECENT} 10:00`},
]});
check('paid code on unpaid activity refused', unpaid.status === 400, `status ${unpaid.status}`);

console.log('=== APPROVAL RULES ===');
const summary = (await call('GET',`/payroll/summary?start=${RANGE_START}&end=${RANGE_END}`,TL)).body.rows;
check('payroll summary returns rows', summary.length > 0);
const inProgress = summary.find((r) => r.inProgress);
if (inProgress) {
  const r = await call('POST',`/timecards/${inProgress.userId}/${inProgress.payrollDate}/approve`,TL,{approved:true});
  check('cannot approve a running shift', r.body?.ok === false, JSON.stringify(r.body?.message));
} else check('no running shift to test (skipped)', true);
const bulk = (await call('POST','/payroll/approve-clean',TL,{start:OLD,end:RANGE_END})).body;
check('bulk approve returns a result', Array.isArray(bulk?.approved));
check('bulk approve refuses cards with exceptions',
  bulk.skipped.every((s) => s.reason && s.reason.length > 0), JSON.stringify(bulk.skipped.slice(0,2)));
const second = (await call('POST','/payroll/approve-clean',TL,{start:OLD,end:RANGE_END})).body;
check('bulk approve is idempotent', second.approved.length === 0, `approved ${second.approved.length} on rerun`);

console.log('=== CLOCK RULES ===');
const clock = (await call('GET','/clock',ADV)).body;
check('clock state returned', typeof clock?.canClockOn === 'boolean');
if (!clock.canClockOn) {
  const r = await call('POST','/clock/punch',ADV,{type:'ON',activity:'01-001'});
  check('cannot clock on outside the window', r.body?.ok === false, JSON.stringify(r.body?.message));
} else check('advisor is inside their window (skipped)', true);
check('unknown activity refused',
  (await call('POST','/clock/punch',ADV,{type:'ON',activity:'zz-999'})).body?.ok === false);

console.log('=== SCHEDULING RULES ===');
const shiftRule = await call('POST','/admin/shift-rule',TL,{userId:target.id,shiftRule:'CR2',effectiveDate:day(-7)});
check('shift rule change in the past refused', shiftRule.status === 400, `status ${shiftRule.status}`);
check('shift rule change in the future allowed',
  (await call('POST','/admin/shift-rule',TL,{userId:target.id,shiftRule:'CR2',effectiveDate:FUTURE})).status === 200);
const ge = await call('POST','/schedules/group-exception',TL,{date:day(2),activityKey:'TEAM_MEETING',startTime:'10:00',endTime:'10:30'});
check('group exception applies', Array.isArray(ge.body?.applied), JSON.stringify(ge.body).slice(0,120));
const unge = await call('POST','/schedules/group-exception/remove',TL,{date:day(2),activityKey:'TEAM_MEETING',startTime:'10:00',endTime:'10:30'});
check('group exception can be removed', (unge.body?.removed?.length ?? 0) === (ge.body?.applied?.length ?? -1),
  `applied ${ge.body?.applied?.length} removed ${unge.body?.removed?.length}`);

console.log('=== DRAFT AND PUBLISH ===');
// The seed drafts the week after next. Find it.
const draftWeek = await call('GET',`/schedules/team?start=${day(3)}&end=${day(9)}`,TL);
check('drafts are reported to the planner', (draftWeek.body?.drafts ?? 0) > 0, `drafts ${draftWeek.body?.drafts}`);
const draftDay = (draftWeek.body?.people ?? [])
  .flatMap((p) => p.days.map((d) => ({ userId: p.userId, ...d })))
  .find((d) => d.shifts.some((s) => s.status === 'DRAFT'));
check('a drafted shift carries its state', !!draftDay, JSON.stringify(draftDay?.shifts?.[0]?.status));

if (draftDay) {
  const theirEmail = (await call('GET',`/people/${draftDay.userId}`,TL)).body?.person?.email;
  const theirToken = await tok(theirEmail);

  const own = (await call('GET',`/schedules/${draftDay.userId}?start=${draftDay.date}&end=${draftDay.date}`,TL)).body;
  check('the planner sees the draft', (own.days[0]?.shifts.length ?? 0) > 0);

  // The advisor must not see it, even asking about themselves.
  const asThem = await call('GET',
    `/schedules/${draftDay.userId}?start=${draftDay.date}&end=${draftDay.date}`, theirToken);
  check('the advisor does not see their own draft',
    (asThem.body?.days?.length ?? 0) === 0, JSON.stringify(asThem.body).slice(0,120));

  // Publishing is supervisor-only, idempotent, and tells people.
  check('advisors cannot publish',
    (await call('POST','/schedules/publish',ADV,{start:day(3),end:day(9)})).status === 403);
  check('publish refuses a backwards range',
    (await call('POST','/schedules/publish',TL,{start:day(9),end:day(3)})).status === 400);

  const pub = await call('POST','/schedules/publish',TL,{start:draftDay.date,end:draftDay.date});
  check('publishing reports what it published', (pub.body?.published ?? 0) > 0, JSON.stringify(pub.body).slice(0,120));
  check('publishing names who to tell', (pub.body?.affected?.length ?? 0) > 0);

  const again = await call('POST','/schedules/publish',TL,{start:draftDay.date,end:draftDay.date});
  check('publishing twice does not re-notify', again.body?.published === 0, JSON.stringify(again.body));

  const nowVisible = await call('GET',
    `/schedules/${draftDay.userId}?start=${draftDay.date}&end=${draftDay.date}`, theirToken);
  check('the advisor sees it once published', (nowVisible.body?.days?.length ?? 0) > 0);
} else check('no draft to publish (skipped)', true);

check('a day already worked is never a draft',
  ((await call('GET',`/schedules/team?start=${day(-3)}&end=${day(-1)}`,TL)).body?.drafts ?? -1) === 0);

console.log('=== TEAM WEEK ===');
const tw = await call('GET',`/schedules/team?start=${day(0)}&end=${day(6)}`,TL);
check('team week returns seven days', tw.body?.dates?.length === 7, JSON.stringify(tw.body?.dates));
check('team week returns people', (tw.body?.people?.length ?? 0) > 0);
check('every person has a cell per date',
  (tw.body?.people ?? []).every((p) => p.days.length === 7));
check('team week is supervisor only', (await call('GET',`/schedules/team?start=${day(0)}&end=${day(6)}`,ADV)).status === 403);
check('team week carries cover per date',
  Array.isArray(tw.body?.cover) && tw.body.cover.length === 7, `${tw.body?.cover?.length} cover entries`);
check('cover is read at the worst interval, not a tied peak',
  (tw.body?.cover ?? []).every((c) => !c.forecast || (c.worstVariance === c.scheduledAtWorst - c.requiredAtWorst)),
  JSON.stringify((tw.body?.cover ?? [])[0]));
check('short intervals never exceed intervals with demand',
  (tw.body?.cover ?? []).every((c) => c.shortIntervals <= c.demandIntervals));
check('a day with no forecast says so rather than reporting zero cover',
  (tw.body?.cover ?? []).every((c) => c.forecast || (c.shortIntervals === 0 && c.worstAt === null)));
check('team week refuses a backwards range', (await call('GET',`/schedules/team?start=${day(6)}&end=${day(0)}`,TL)).status === 400);
check('team week refuses a huge range', (await call('GET',`/schedules/team?start=${day(0)}&end=${day(200)}`,TL)).status === 400);

// Move a future shift onto a day that person has off, then put it back. A day
// that already has a shift is a different rule — overlap — and is checked below.
const movable = (tw.body?.people ?? [])
  .flatMap((p) =>
    p.days
      .filter((d) => d.date > day(0) && d.shifts.length === 1)
      .map((d) => ({
        userId: p.userId,
        ...d,
        free: p.days.find((o) => o.date > day(0) && o.date !== d.date && o.shifts.length === 0)?.date,
      })),
  )
  .find((d) => d.free);
if (movable) {
  const to = movable.free;
  const moved = await call('POST','/schedules/move',TL,
    {userId:movable.userId,fromDate:movable.date,toDate:to,shiftNo:movable.shifts[0].shiftNo});
  check('a future shift can be moved', moved.body?.ok === true, JSON.stringify(moved.body).slice(0,160));
  if (moved.body?.ok) {
    const after = (await call('GET',`/schedules/${movable.userId}?start=${movable.date}&end=${movable.date}`,TL)).body;
    check('the source day is empty afterwards',
      (after.days.find((d) => d.date === movable.date)?.shifts.length ?? 0) === 0);
    const landed = (await call('GET',`/schedules/${movable.userId}?start=${to}&end=${to}`,TL)).body;
    check('the shift landed on the target day', (landed.days[0]?.shifts.length ?? 0) > 0);
    check('the clock time survived the move',
      landed.days[0].shifts.some((s) => s.rows[0].startAt.slice(11) === movable.shifts[0].rows[0].startAt.slice(11)),
      JSON.stringify(landed.days[0]?.shifts?.map((s)=>s.rows[0].startAt)));
    // Put it back so a re-run finds the week as it was.
    const back = landed.days[0].shifts.find((s) => s.rows[0].startAt.slice(11) === movable.shifts[0].rows[0].startAt.slice(11));
    await call('POST','/schedules/move',TL,{userId:movable.userId,fromDate:to,toDate:movable.date,shiftNo:back.shiftNo});
  }
} else check('no future shift to move (skipped)', true);

// Onto a day the same person already works: allowed only if the two fit.
const doubled = (tw.body?.people ?? [])
  .map((p) => ({
    userId: p.userId,
    busy: p.days.filter((d) => d.date > day(0) && d.shifts.length === 1),
  }))
  .find((p) => p.busy.length >= 2);
if (doubled) {
  const [a, b] = doubled.busy;
  const onto = await call('POST','/schedules/move',TL,
    {userId:doubled.userId,fromDate:a.date,toDate:b.date,shiftNo:a.shifts[0].shiftNo});
  check('a move onto an occupied day is judged, not assumed',
    typeof onto.body?.ok === 'boolean' && (onto.body.ok === true || Array.isArray(onto.body.issues)),
    JSON.stringify(onto.body).slice(0,160));
  if (onto.body?.ok) {
    // It fitted; both shifts are now on one day. Put the first one back.
    const both = (await call('GET',`/schedules/${doubled.userId}?start=${b.date}&end=${b.date}`,TL)).body;
    const back = both.days[0].shifts.find((s) => s.rows[0].startAt.slice(11) === a.shifts[0].rows[0].startAt.slice(11));
    if (back) {
      await call('POST','/schedules/move',TL,
        {userId:doubled.userId,fromDate:b.date,toDate:a.date,shiftNo:back.shiftNo});
    }
  }
} else check('nobody works two future days to double up (skipped)', true);

check('a move into the past is refused',
  (await call('POST','/schedules/move',TL,{userId:target.id,fromDate:day(-3),toDate:day(-2),shiftNo:1})).body?.ok === false);
check('a move onto the same day is refused',
  (await call('POST','/schedules/move',TL,{userId:target.id,fromDate:day(2),toDate:day(2),shiftNo:1})).body?.ok === false);
check('advisors cannot move shifts',
  (await call('POST','/schedules/move',ADV,{userId:target.id,fromDate:day(2),toDate:day(3),shiftNo:1})).status === 403);

console.log('=== WORKING TIME & LEAVE ===');
check('team week reports who breaches a limit', typeof tw.body?.breaching === 'number');
check('a breach names the rule it broke',
  (tw.body?.people ?? []).every((p) =>
    (p.breaches ?? []).every((b) =>
      ['rest','consecutive','weekly','daily','break','overtime'].includes(b.kind) && b.message)),
  JSON.stringify((tw.body?.people ?? []).flatMap((p) => p.breaches ?? []).slice(0,2)));
check('the seeded roster is mostly legal',
  (tw.body?.breaching ?? 99) <= 4, `${tw.body?.breaching} of ${tw.body?.people?.length} breaching`);
check('every day carries a leave field',
  (tw.body?.people ?? []).every((p) => p.days.every((d) => 'leave' in d)));

// Approved leave should show as leave, not as a blank day.
const leaveWeek = await call('GET',`/schedules/team?start=${day(0)}&end=${day(9)}`,TL);
const onLeave = (leaveWeek.body?.people ?? [])
  .flatMap((p) => p.days.map((d) => ({ userId: p.userId, ...d })))
  .find((d) => d.leave);
check('approved leave is visible on the grid', !!onLeave, JSON.stringify(onLeave?.leave));

if (onLeave) {
  // Dragging a shift onto a leave day is new work on a day they are not there.
  const donor = (leaveWeek.body?.people ?? [])
    .find((p) => p.userId === onLeave.userId)
    ?.days.find((d) => d.date > day(0) && d.date !== onLeave.date && d.shifts.length === 1);
  if (donor) {
    const onto = await call('POST','/schedules/move',TL,
      {userId:onLeave.userId,fromDate:donor.date,toDate:onLeave.date,shiftNo:donor.shifts[0].shiftNo});
    check('a shift cannot be dragged onto approved leave',
      onto.body?.ok === false && /leave|not there/i.test(onto.body?.message ?? ''),
      JSON.stringify(onto.body).slice(0,160));
  } else check('no donor shift for the leave-drag check (skipped)', true);

  // The day editor warns instead of refusing: approving leave does not delete
  // a shift that was already there, so blocking the edit would be wrong.
  const editing = await call('PUT',`/schedules/${onLeave.userId}/${onLeave.date}`,TL,{shifts:[{
    shiftNo:1,
    rows:[{startAt:`${onLeave.date} 09:00`,activityKey:'SHIFT_START'}],
    endAt:`${onLeave.date} 17:00`,
  }]});
  check('the editor warns about leave rather than refusing',
    editing.status === 200 && (editing.body?.issues ?? []).some((i) => /approved/i.test(i.message)),
    JSON.stringify(editing.body?.issues ?? []).slice(0,160));
  // Put the day back as it was.
  await call('PUT',`/schedules/${onLeave.userId}/${onLeave.date}`,TL,{shifts:[]});
}

console.log('=== FORECAST & PLANNING ===');
const fc = (await call('GET',`/forecast?date=${day(2)}`,TL)).body;
check('forecast returns a full grid', fc?.forecast?.length === 48, `${fc?.forecast?.length} intervals`);
check('coverage computed', Array.isArray(fc?.coverage) && fc.coverage.length === 48);
check('summary has projected service level', typeof fc?.summary?.projectedServiceLevel === 'number');
const saved = await call('PUT','/forecast',TL,{date:day(12),rows:[{startTime:'09:00',volume:40,ahtSeconds:240}]});
check('forecast can be saved', saved.status === 200, `status ${saved.status}`);
const reread = (await call('GET',`/forecast?date=${day(12)}`,TL)).body;
check('saved forecast reads back', reread.forecast.find((r)=>r.startTime==='09:00')?.volume === 40);
const staffing = (await call('GET','/forecast/staffing?volume=100&ahtSeconds=240&serviceGoal=0.8&targetSeconds=20&shrinkage=0.3',TL)).body;
check('erlang staffing returns agents', staffing.requiredAgents > staffing.agentsOnPhone, JSON.stringify(staffing));
check('erlang service level between 0 and 1', staffing.serviceLevel >= 0 && staffing.serviceLevel <= 1);

console.log('=== LEAVE COVER CHECK ===');
const reqs = (await call('GET','/absence/requests',TL)).body.requests;
const pendingReq = reqs.find((r) => r.status === 'PENDING');
if (pendingReq) {
  const impact = await call('GET',`/absence/requests/${pendingReq.id}/impact`,TL);
  check('leave impact computed', impact.status === 200 && typeof impact.body?.summary === 'string', JSON.stringify(impact.body).slice(0,140));
  check('leave impact has a severity', ['none','watch','high'].includes(impact.body?.severity));
} else check('no pending request to assess (skipped)', true);
check('accrual over-request refused',
  (await call('POST','/absence/requests',ADV,{accrualType:'VACATION',startDate:day(24),endDate:day(53),hours:9999})).status === 400);

console.log('=== ALERTS ===');
const snap = (await call('GET','/intraday',TL)).body;
check('intraday snapshot returns totals', typeof snap?.totals?.adherencePct === 'number');
check('every alert has a stable key', (snap.alerts ?? []).every((a) => typeof a.key === 'string' && a.key.length > 0));
if (snap.alerts?.length) {
  const a = snap.alerts[0];
  const ack = await call('POST',`/alerts/${encodeURIComponent(a.key)}/ack`,TL,{userId:a.userId});
  check('alert can be claimed', ack.body?.ok === true, JSON.stringify(ack.body));
  const again = await call('POST',`/alerts/${encodeURIComponent(a.key)}/ack`,NTL,{userId:a.userId});
  check('second claimer is told who has it', again.body?.ok === false && !!again.body?.ackedByName, JSON.stringify(again.body));
  const after = (await call('GET','/intraday',TL)).body;
  check('claim shows on the board', after.alerts.find((x)=>x.key===a.key)?.ackedBy != null);
  check('alert can be handed back', (await call('DELETE',`/alerts/${encodeURIComponent(a.key)}/ack`,TL)).body?.ok === true);
} else check('no alerts to claim (skipped)', true);

console.log('=== PAYROLL EXPORT ===');
const exp = (await call('GET',`/payroll/export?start=${RANGE_START}&end=${RANGE_END}`,TL)).body;
check('export returns rows', Array.isArray(exp?.rows));
check('export rows carry minutes', exp.rows.every((r) => typeof r.minutes === 'number' && r.minutes >= 0));
check('export is approved-only by default', exp.approvedOnly === true);

console.log('=== REPORTS & ANALYTICS ===');
check('adherence report', (await call('GET',`/reports/adherence?userId=${target.id}&date=${day(-3)}`,TL)).status === 200);
const an = (await call('GET',`/analytics?start=${day(-14)}&end=${RANGE_END}`,TL)).body;
check('analytics returns trend', Array.isArray(an?.trend) && an.trend.length > 0);
check('analytics adherence is a percentage', an.totals.adherencePct >= 0 && an.totals.adherencePct <= 100);
check('scorecards sorted by exceptions',
  an.scorecards.every((s,i,arr) => i===0 || arr[i-1].exceptionCount >= s.exceptionCount));
check('exception report', Array.isArray((await call('GET',`/reports/exceptions?start=${day(-38)}&end=${RANGE_END}`,TL)).body?.rows));
check('query tool returns minutes',
  ((await call('GET',`/reports/query?start=${day(-38)}&end=${RANGE_END}`,TL)).body?.rows ?? []).every((r)=>typeof r.minutes === 'number'));

console.log('=== SELF SERVICE ===');
check('swaps list', Array.isArray((await call('GET','/swaps',ADV)).body?.swaps));
check('cannot swap with yourself',
  (await call('POST','/swaps',ADV,{requesterDate:day(4),counterpartyId:6,counterpartyDate:day(5)})).body?.ok === false);
check('extra hours list', Array.isArray((await call('GET','/extra-hours',ADV)).body?.offers));
const offers = (await call('GET','/extra-hours',ADV)).body.offers;
const closed = offers.find((o) => o.status !== 'OPEN');
if (closed) check('cannot bid on a closed offer', (await call('POST',`/extra-hours/${closed.id}/bid`,ADV)).body?.ok === false);
else check('no closed offer to test (skipped)', true);

console.log('=== LEAVE BALANCE ===');
const advId2 = (await call('GET','/auth/me',ADV)).body.user.id;
const before = (await call('GET','/people/'+advId2,TL)).body.accruals.find((a)=>a.accrual_type==='VACATION');
const bal = before?.balance_hours ?? 0;
check('advisor has a vacation balance', bal > 0, `${bal} hours`);

// Whatever is genuinely left, so this holds however many requests earlier
// checks or a human left on file — the pass must not depend on a fresh seed.
const mine = (await call('GET','/absence/requests',ADV)).body?.requests ?? [];
const pendingVac = mine
  .filter((r) => r.status === 'PENDING' && r.accrual_type === 'VACATION')
  .reduce((sum, r) => sum + r.hours, 0);
const room = bal - pendingVac;

// Far enough out that nothing seeded or previously requested sits there.
const far = (n) => day(400 + n * 5);

if (room > 0) {
  // The defect: each request was checked against the balance and none against
  // the others, so the same room could be claimed over and over.
  const first = await call('POST','/absence/requests',ADV,
    {accrualType:'VACATION',startDate:far(0),endDate:far(0),hours:room});
  const secondTry = await call('POST','/absence/requests',ADV,
    {accrualType:'VACATION',startDate:far(1),endDate:far(1),hours:room});
  check('the balance can be claimed once', first.status === 200, `status ${first.status}`);
  check('the same balance cannot be claimed twice',
    secondTry.status === 400, `status ${secondTry.status} with ${room}h room`);
  check('the refusal explains what is already spoken for',
    /waiting|accrued/.test(secondTry.body?.error ?? secondTry.body?.message ?? ''),
    JSON.stringify(secondTry.body).slice(0,140));
} else check('no vacation room left to test the balance rule (skipped)', true);

check('an overlapping request is refused',
  (await call('POST','/absence/requests',ADV,
    {accrualType:'SICK',startDate:far(0),endDate:far(0),hours:8})).status === 400);
check('a backwards range is refused',
  (await call('POST','/absence/requests',ADV,
    {accrualType:'VACATION',startDate:day(420),endDate:day(410),hours:8})).status === 400);
/*
 * A date unique to this run. The first version used a fixed day, which passed
 * once and then failed against its own leftover on the next run — the overlap
 * rule correctly refusing a request identical to the one the previous run had
 * left on file. A check that only works on a fresh database is a check that
 * will be ignored.
 */
const unpaidFar = day(600 + (Date.now() % 300));
check('unpaid leave ignores the balance',
  (await call('POST','/absence/requests',ADV,
    {accrualType:'UNPAID',startDate:unpaidFar,endDate:unpaidFar,hours:9999})).status === 200);
check('unpaid leave still cannot overlap',
  (await call('POST','/absence/requests',ADV,
    {accrualType:'UNPAID',startDate:unpaidFar,endDate:unpaidFar,hours:8})).status === 400);

console.log('=== PERSONAL HISTORY ===');
const hist = await call('GET',`/history/${target.id}`,TL);
check('history returns entries', Array.isArray(hist.body?.entries), JSON.stringify(hist.body).slice(0,100));
check('every entry says what happened',
  (hist.body?.entries ?? []).every((e) => typeof e.what === 'string' && e.what.length > 0));
check('every entry is kinded',
  (hist.body?.entries ?? []).every((e) => ['schedule','timecard','approval'].includes(e.kind)));
check('an advisor can read their own history', (await call('GET','/history/6',ADV)).status === 200 || (await call('GET',`/history/${(await call('GET','/auth/me',ADV)).body.user.id}`,ADV)).status === 200);
const advId = (await call('GET','/auth/me',ADV)).body.user.id;
check('an advisor reads their own', (await call('GET',`/history/${advId}`,ADV)).status === 200);
const stranger = otherTeam.find((p) => p.id !== advId && !people.some((q) => q.id === p.id));
if (stranger) {
  check("an advisor cannot read somebody else's history",
    (await call('GET',`/history/${stranger.id}`,ADV)).status === 403);
} else check('no stranger to test history scoping (skipped)', true);

console.log('=== RULES LOG ===');
const rules = await call('GET','/admin/rules-log',TL);
check('rules log returns entries', Array.isArray(rules.body?.entries));
check('rules log is supervisor only', (await call('GET','/admin/rules-log',ADV)).status === 403);
check('every rule change is kinded',
  (rules.body?.entries ?? []).every((e) =>
    ['shift-rule','forecast-settings','payroll-run','schedule-publish'].includes(e.kind)));
check('the future-dated shift rule shows as pending',
  (rules.body?.entries ?? []).some((e) => e.kind === 'shift-rule' && e.pending === true),
  JSON.stringify((rules.body?.entries ?? []).filter((e)=>e.kind==='shift-rule').slice(0,2)));
check('rules log excludes ordinary timecard edits',
  (rules.body?.entries ?? []).every((e) => e.kind !== 'timecard'));

console.log('=== MULTI-SKILL ===');
const ms = await call('POST','/forecast/multi-skill',TL,{
  skills:[{key:'en',volume:50,ahtSeconds:240},{key:'ar',volume:30,ahtSeconds:270}],
  pools:[{key:'english',skills:['en']},{key:'arabic',skills:['ar']},{key:'both',skills:['en','ar']}],
  serviceGoal:0.8,targetSeconds:20,shrinkage:0.3,
});
check('multi-skill returns a plan', typeof ms.body?.agentsOnPhone === 'number', JSON.stringify(ms.body).slice(0,140));
check('multi-skill applies shrinkage',
  ms.body?.requiredAgents === Math.ceil(ms.body?.agentsOnPhone / 0.7), `${ms.body?.agentsOnPhone} -> ${ms.body?.requiredAgents}`);
check('multi-skill reports both Erlang bounds',
  typeof ms.body?.pooledEquivalent === 'number' && typeof ms.body?.isolatedEquivalent === 'number');
check('splitting the traffic costs more than pooling it',
  ms.body?.isolatedEquivalent > ms.body?.pooledEquivalent,
  `isolated ${ms.body?.isolatedEquivalent} pooled ${ms.body?.pooledEquivalent}`);
check('every skill gets a verdict', (ms.body?.perSkill?.length ?? 0) === 2);
check('multi-skill is deterministic',
  JSON.stringify((await call('POST','/forecast/multi-skill',TL,{
    skills:[{key:'en',volume:50,ahtSeconds:240},{key:'ar',volume:30,ahtSeconds:270}],
    pools:[{key:'english',skills:['en']},{key:'arabic',skills:['ar']},{key:'both',skills:['en','ar']}],
    serviceGoal:0.8,targetSeconds:20,shrinkage:0.3,
  })).body) === JSON.stringify(ms.body));
check('a pool trained on an unlisted skill is refused',
  (await call('POST','/forecast/multi-skill',TL,{
    skills:[{key:'en',volume:50,ahtSeconds:240}],
    pools:[{key:'x',skills:['nope']}],serviceGoal:0.8,targetSeconds:20,shrinkage:0.3,
  })).status === 400);
check('a skill nobody can take is refused',
  (await call('POST','/forecast/multi-skill',TL,{
    skills:[{key:'en',volume:50,ahtSeconds:240},{key:'ar',volume:20,ahtSeconds:240}],
    pools:[{key:'english',skills:['en']}],serviceGoal:0.8,targetSeconds:20,shrinkage:0.3,
  })).status === 400);
check('multi-skill is supervisor only',
  (await call('POST','/forecast/multi-skill',ADV,{
    skills:[{key:'en',volume:10,ahtSeconds:240}],pools:[{key:'e',skills:['en']}],
  })).status === 403);

console.log('=== NOTIFICATIONS ===');
const notif = (await call('GET','/notifications',TL)).body;
check('notifications returned', Array.isArray(notif?.notifications));
check('unread count matches', notif.unread === notif.notifications.filter((n)=>!n.read).length);
check('mark all read', (await call('POST','/notifications/read-all',TL)).body?.ok === true);
check('unread is zero after', (await call('GET','/notifications',TL)).body?.unread === 0);

console.log('=== PAY, HOLIDAYS AND COST ===');
const rates = (await call('GET','/pay/rates',ADV)).body;
check('rates are readable by everybody', rates?.rates?.overtimeDay === 1.35);
check('night overtime is the higher rate', rates.rates.overtimeNight > rates.rates.overtimeDay);
check('the basis of every rate is stated', (rates?.basis ?? '').includes('Law No. 14'));

// Two years, because this script is run repeatedly against the same database
// and confirming a holiday is a permanent change. SHAPE is only ever read, so
// its assertions hold on the hundredth run as well as the first.
const YEAR = new Date().getUTCFullYear();
const SHAPE = YEAR + 5, MOVE = YEAR + 3;
const shapeCal = (await call('GET',`/pay/holidays?start=${SHAPE}-01-01&end=${SHAPE}-12-31`,ADV)).body?.holidays ?? [];
check('a year is given a holiday calendar on demand', shapeCal.length > 10, `${shapeCal.length} holidays`);
check('Labour Day is on it', shapeCal.some((h) => h.date === `${SHAPE}-05-01`));
check('the fixed dates arrive confirmed',
  shapeCal.filter((h) => h.basis !== 'ISLAMIC').every((h) => h.confirmed));
check('the Islamic dates arrive unconfirmed, because Egypt settles them by sighting',
  shapeCal.filter((h) => h.basis === 'ISLAMIC').length > 0 &&
  shapeCal.filter((h) => h.basis === 'ISLAMIC').every((h) => !h.confirmed));
check('no date appears twice', new Set(shapeCal.map((h) => h.date)).size === shapeCal.length);
check('generating a calendar twice does not duplicate it',
  JSON.stringify((await call('GET',`/pay/holidays?start=${SHAPE}-01-01&end=${SHAPE}-12-31`,ADV)).body?.holidays)
    === JSON.stringify(shapeCal));
check('every holiday is inside the year asked for',
  shapeCal.every((h) => h.date.startsWith(String(SHAPE))));

// Settling changes what a region is paid for a day, so it is above supervisor.
const moveCal = (await call('GET',`/pay/holidays?start=${MOVE}-01-01&end=${MOVE}-12-31`,ADV)).body?.holidays ?? [];
const unconfirmed = moveCal.filter((h) => !h.confirmed);
check('there is an estimated date to settle', unconfirmed.length > 1);
check('a team leader cannot settle a holiday',
  (await call('POST',`/pay/holidays/${unconfirmed[0].date}/settle`,TL,{})).status === 403);
check('a date that is not a holiday cannot be settled',
  (await call('POST','/pay/holidays/1999-01-01/settle',OM,{})).status === 400);
check('an ops manager confirms an estimated date',
  (await call('POST',`/pay/holidays/${unconfirmed[0].date}/settle`,OM,{})).body?.ok === true);
check('confirming sticks',
  (await call('GET',`/pay/holidays?start=${unconfirmed[0].date}&end=${unconfirmed[0].date}`,ADV))
    .body?.holidays?.[0]?.confirmed === true);
check('a holiday cannot be moved onto another holiday',
  (await call('POST',`/pay/holidays/${unconfirmed[0].date}/settle`,OM,{actualDate:`${MOVE}-05-01`})).status === 400);

console.log('=== WHAT A DAY COSTS ===');
const costed = (await call('GET',`/payroll/summary?start=${RANGE_START}&end=${RANGE_END}`,TL)).body?.rows ?? [];
check('every payroll row carries a cost', costed.every((r) => typeof r.paidMinutes === 'number'));
check('every payroll row says what kind of day it was',
  costed.every((r) => ['ORDINARY','REST_DAY','PUBLIC_HOLIDAY'].includes(r.dayCharacter)));
check('an ordinary day with no overtime costs exactly what it worked',
  costed.filter((r) => r.dayCharacter === 'ORDINARY' && r.overtime === '00:00')
    .every((r) => r.premiumMinutes === 0));
const restDays = costed.filter((r) => r.dayCharacter === 'REST_DAY' && r.paidMinutes > 0);
check('a cancelled rest day costs double',
  restDays.length > 0 && restDays.every((r) => r.paidMinutes === r.premiumMinutes * 2),
  `${restDays.length} cancelled rest days`);

const cost = (await call('GET',`/pay/cost/6?start=${RANGE_START}&end=${RANGE_END}`,TL)).body;
check('a cost breakdown covers every day in the range',
  cost?.days?.length === Math.round((Date.parse(RANGE_END) - Date.parse(RANGE_START)) / 86400000) + 1);
check('the total matches the days',
  cost.total.paidMinutes === Math.round(cost.days.reduce((s,d) => s + d.paidMinutes, 0) * 100) / 100);
check('paid is never less than worked', cost.days.every((d) => d.paidMinutes >= d.workedMinutes));
// Layla is user 6; user 3 is a peer on the same team.
check('an advisor can see their own cost',
  (await call('GET',`/pay/cost/6?start=${RECENT}&end=${RECENT}`,ADV)).status === 200);
check("an advisor cannot see a peer's cost",
  (await call('GET',`/pay/cost/3?start=${RECENT}&end=${RECENT}`,ADV)).status === 403);

const roster = (await call('GET',`/pay/roster?start=${RANGE_START}&end=${RANGE_END}&drafts=true`,TL)).body;
check('a roster can be costed before it is worked', roster?.total?.paidMinutes > 0);
check('roster cost is supervisor only',
  (await call('GET',`/pay/roster?start=${RANGE_START}&end=${RANGE_END}`,ADV)).status === 403);

console.log('=== SETTLING A WORKED HOLIDAY ===');
// Build the case rather than hunt for it. Moving an estimated holiday onto a
// day somebody actually worked is the real workflow — an Eid announced a day
// off the arithmetic calendar's guess — and it is the only way to get a worked
// public holiday into a seeded week. Guarded so a second run does not try to
// move a second holiday onto a date that is already one.
const alreadyHoliday = (await call('GET',`/pay/holidays?start=${RECENT}&end=${RECENT}`,ADV)).body?.holidays ?? [];
if (alreadyHoliday.length === 0) {
  const spare = (await call('GET',`/pay/holidays?start=${MOVE}-01-01&end=${MOVE}-12-31`,ADV))
    .body?.holidays?.find((h) => !h.confirmed);
  check('an announced date can be moved onto the day it fell on',
    (await call('POST',`/pay/holidays/${spare.date}/settle`,OM,{actualDate:RECENT})).body?.ok === true);
  check('the estimate it replaced is gone, not left beside it',
    !((await call('GET',`/pay/holidays?start=${spare.date}&end=${spare.date}`,ADV)).body?.holidays ?? [])
      .some((h) => h.date === spare.date));
}
check('the worked day is now a public holiday',
  ((await call('GET',`/pay/holidays?start=${RECENT}&end=${RECENT}`,ADV)).body?.holidays ?? []).length === 1);

const summaryOn = async (date) =>
  (await call('GET',`/payroll/summary?start=${date}&end=${date}`,TL)).body?.rows ?? [];
const holidayRow = (await summaryOn(RECENT)).find((r) => r.paidMinutes > 0);
check('a worked holiday reads as one on the payroll summary',
  holidayRow?.dayCharacter === 'PUBLIC_HOLIDAY', JSON.stringify(holidayRow?.dayCharacter));

const holidayCard = (await call('GET',`/timecards/${holidayRow.userId}/${RECENT}`,OM)).body?.timecard;
check('a card exists on the holiday to settle', !!holidayCard, `user ${holidayRow?.userId} on ${RECENT}`);

// Only true on a virgin database — a second run of this script has already
// settled the card. Asserted where it holds rather than skipped, because the
// unsettled state is the one a real supervisor meets first.
if (holidayCard.holidayElection === null) {
  check('an unsettled holiday says so', holidayRow.electionOutstanding === true);
  check('and is costed at triple until somebody decides',
    holidayRow.paidMinutes === holidayRow.premiumMinutes * 1.5,
    `paid ${holidayRow.paidMinutes} premium ${holidayRow.premiumMinutes}`);
}
check('an advisor cannot settle a holiday',
  (await call('POST',`/pay/timecards/${holidayCard.id}/holiday-election`,ADV,{election:'PAY_3X'})).status === 403);
check('an unknown settlement is refused',
  (await call('POST',`/pay/timecards/${holidayCard.id}/holiday-election`,OM,{election:'FREE'})).status === 400);

const bank = async () => (await call('GET',`/absence/accruals?userId=${holidayRow.userId}`,OM)).body?.accruals
  ?.find((b) => b.accrual_type === 'VACATION')?.balance_hours ?? 0;

// Start from cash so the sequence below is the same on every run.
await call('POST',`/pay/timecards/${holidayCard.id}/holiday-election`,OM,{election:'PAY_3X'});
const cashRow = (await summaryOn(RECENT)).find((r) => r.userId === holidayRow.userId);
check('settled for cash, nothing is outstanding', cashRow.electionOutstanding === false);
check('and it costs triple', cashRow.paidMinutes === cashRow.premiumMinutes * 1.5,
  `paid ${cashRow.paidMinutes} premium ${cashRow.premiumMinutes}`);
const cashCost = cashRow.paidMinutes;
const bankBefore = await bank();
check('a supervisor settles it at double plus a banked day',
  (await call('POST',`/pay/timecards/${holidayCard.id}/holiday-election`,OM,{election:'PAY_2X_PLUS_DAY'})).body?.ok === true);
const bankAfter = await bank();
check('the banked day reaches the balance', bankAfter === bankBefore + 8, `${bankBefore} -> ${bankAfter}`);
check('and the day now costs double rather than triple',
  (await summaryOn(RECENT)).find((r) => r.userId === holidayRow.userId)?.paidMinutes === cashCost / 1.5,
  `expected ${cashCost / 1.5}`);

// The click-twice case.
await call('POST',`/pay/timecards/${holidayCard.id}/holiday-election`,OM,{election:'PAY_2X_PLUS_DAY'});
check('settling the same way twice banks one day, not two', (await bank()) === bankAfter);

// And changing your mind must take it back.
await call('POST',`/pay/timecards/${holidayCard.id}/holiday-election`,OM,{election:'PAY_3X'});
check('changing to cash takes the banked day back', (await bank()) === bankBefore, `expected ${bankBefore}`);

console.log('=== PLANNING WITHOUT A PROJECT ===');
// The Administrator belongs to no project by design, and every planning screen
// used to answer them "No project is associated with your account" — dead
// screens for the one account meant to see everything.
const adminForecast = await call('GET','/forecast',ADM);
check('an administrator can read the forecast', adminForecast.status === 200,
  JSON.stringify(adminForecast.body).slice(0, 90));
check('and gets a real project back', typeof adminForecast.body?.projectId === 'string');
check('an administrator can read coverage-driven screens',
  (await call('GET','/intraday',ADM)).status === 200);
check('asking for a project explicitly still wins',
  (await call('GET','/forecast?project=B900',ADM)).body?.projectId === 'B900');
check('somebody with a project of their own still gets theirs',
  (await call('GET','/forecast',TL)).body?.projectId === 'A123');
check('an advisor is still refused the forecast',
  (await call('GET','/forecast',ADV)).status === 403);

console.log('=== NIGHT ALLOWANCE AND RAMADAN ===');
const thisMonth = day(0).slice(0, 7);
const lastMonth = day(-32).slice(0, 7);

const na = (await call('GET',`/pay/night-allowance/6?month=${thisMonth}`,TL)).body;
check('a night allowance comes back as a fraction', /^\d+\/\d+$/.test(na?.fraction ?? ''), na?.fraction);
check('worked never exceeds scheduled', na.worked <= na.scheduled);
check('the percentage agrees with the fraction',
  na.scheduled === 0 || Math.abs(na.percent - (na.worked / na.scheduled) * 100) < 0.1);
check('the nights are listed so a disputed fraction can be checked',
  na.nights.length === na.scheduled, `${na.nights.length} vs ${na.scheduled}`);
check('every listed night is a real date', na.nights.every((n) => /^\d{4}-\d{2}-\d{2}$/.test(n.date)));
check('the current month is not reported as final', na.complete === false);
check('a finished month is reported as final',
  (await call('GET',`/pay/night-allowance/6?month=${lastMonth}`,TL)).body?.complete === true);

// The bug this had first: a night still in the future is not a night somebody
// missed, and counting it as unworked understated the month badly.
check('no night in the future is counted',
  na.nights.every((n) => n.date <= day(0)), JSON.stringify(na.nights.filter((n) => n.date > day(0))));

check('a day worker earns no night allowance',
  (await call('GET',`/pay/night-allowance/${(await call('GET','/people',TL)).body.people.find((p)=>p.role==='TEAM_LEADER').id}?month=${thisMonth}`,TL))
    .body?.scheduled === 0);
check('an advisor can read their own allowance',
  (await call('GET',`/pay/night-allowance/6?month=${thisMonth}`,ADV)).status === 200);
check('an advisor cannot read a peer\'s allowance',
  (await call('GET',`/pay/night-allowance/3?month=${thisMonth}`,ADV)).status === 403);
check('a malformed month is refused',
  (await call('GET','/pay/night-allowance/6?month=August',TL)).status === 400);

const ram = (await call('GET',`/pay/ramadan?start=${YEAR}-01-01&end=${YEAR}-12-31`,ADV)).body;
check('Ramadan is a shorter day, not a holiday', ram?.normHours === 6);
check('Ramadan covers about a month', ram.dates.length >= 28 && ram.dates.length <= 60, `${ram.dates.length} days`);
check('Ramadan dates are in order', JSON.stringify([...ram.dates].sort()) === JSON.stringify(ram.dates));
// A shorter working day, not a day off. Confusing the two would pay a month
// of triple time.
const ramHolidays = (await call('GET',`/pay/holidays?start=${YEAR}-01-01&end=${YEAR}-12-31`,ADV)).body?.holidays ?? [];
check('no Ramadan date is also a public holiday',
  ram.dates.every((d) => !ramHolidays.some((h) => h.date === d)));

console.log('=== FORECAST ACCURACY ===');
const acc = (await call('GET',`/accuracy?start=${day(-14)}&end=${day(-1)}`,OM)).body;
check('accuracy reports over a period', typeof acc?.measured === 'number', JSON.stringify(acc)?.slice(0,120));
check('something was actually measured', acc.measured > 0, `measured ${acc?.measured}`);
check('WAPE is a fraction, not a percentage', acc.wape >= 0 && acc.wape <= 2, `${acc?.wape}`);
// The seed makes weekdays arrive about 7% above forecast, so the bias must be
// positive and visible — a report that averaged it away would be useless.
check('the seeded bias is found, and signed', acc.bias > 0.02, `bias ${acc?.bias}`);
// interpret() only names a direction once the bias is worth correcting; below
// that it says so is noise. Either is a correct reading, and asserting on one
// of them would be asserting on the seed rather than on the code.
check('the bias is always given a reading, one way or the other',
  /low overall|high overall|noise/.test((acc.notes ?? []).join(' ')), (acc.notes ?? []).join(' | '));
check('the weighted error is the headline note', (acc.notes ?? [])[0]?.includes('Weighted error'));
check('handling time bias is separate from volume', Math.abs(acc.ahtBiasSeconds - 20) < 1, `${acc?.ahtBiasSeconds}`);
check('the worst intervals are listed', Array.isArray(acc.worst) && acc.worst.length > 0);
check('worst intervals are ranked by calls', acc.worst.every((w, i) =>
  i === 0 || Math.abs(acc.worst[i-1].error) >= Math.abs(w.error)));
check('there is a per-day breakdown', Array.isArray(acc.byDay) && acc.byDay.length > 0);
// WAPE and MAPE are not ordered — that was a wrong assumption. WAPE weights by
// volume, so it runs *below* MAPE when the bad intervals are quiet ones and
// *above* it when they are busy ones. The seeded spike is on a busy Tuesday
// interval, so here it runs above. What must hold is that they are different
// measures and both are finite.
check('WAPE and MAPE are both real numbers', Number.isFinite(acc.wape) && Number.isFinite(acc.mape));
check('WAPE differs from MAPE, because it weights by volume',
  Math.abs(acc.wape - acc.mape) > 1e-6, `wape ${acc?.wape} mape ${acc?.mape}`);
check('an advisor cannot read forecast accuracy', (await call('GET','/accuracy',ADV)).status === 403);
check('a backwards range is refused', (await call('GET',`/accuracy?start=${day(0)}&end=${day(-5)}`,OM)).status === 400);

// The future has not arrived, so it cannot have been measured.
const future = (await call('GET',`/accuracy?start=${day(3)}&end=${day(6)}`,OM)).body;
check('a period in the future measures nothing', future.measured === 0, `measured ${future?.measured}`);
check('and says so rather than reporting zero error',
  (future.notes ?? []).join(' ').includes('No actual volume'));
check('nulls rather than NaN when nothing is measurable', future.wape === null && future.bias === null);

// Round-trip a correction.
const actualsDate = day(-2);
const actualsBefore = (await call('GET',`/actuals?date=${actualsDate}`,OM)).body?.actuals ?? [];
check('actuals can be read back for a day', actualsBefore.length > 0, `${actualsBefore.length} intervals`);
const put = await call('PUT','/actuals',OM,{date:actualsDate,source:'CHECK',rows:[
  {startTime:'09:00',volume:999,ahtSeconds:300},
  {startTime:'09:30',volume:1,ahtSeconds:300},
]});
check('actuals can be corrected', put.status === 200, `status ${put.status}`);
const actualsAfter = (await call('GET',`/actuals?date=${actualsDate}`,OM)).body?.actuals ?? [];
// Replacing the day rather than merging is the point: a corrected upload that
// omits an interval must not leave the old number sitting there.
check('a correction replaces the day rather than merging into it', actualsAfter.length === 2, `${actualsAfter.length} left`);
check('the corrected number is what comes back', actualsAfter.find((a)=>a.startTime==='09:00')?.volume === 999);
check('an advisor cannot record actuals', (await call('PUT','/actuals',ADV,{date:actualsDate,rows:[]})).status === 403);

// Volume in an interval nobody forecast is error, not absence of data —
// otherwise a planner improves their score by forecasting fewer intervals.
const oddDate = day(-2);
await call('PUT','/actuals',OM,{date:oddDate,rows:[{startTime:'02:30',volume:500,ahtSeconds:240}]});
const withOrphan = (await call('GET',`/accuracy?start=${oddDate}&end=${oddDate}`,OM)).body;
check('an unforecast interval still counts as error',
  withOrphan.actualTotal >= 500, `actualTotal ${withOrphan?.actualTotal}`);

console.log('=== JOINERS, MOVERS, LEAVERS ===');
// A unique suffix per run, so this can be run twice against the same database
// without colliding on the employee ID or email unique constraints.
const stamp = Date.now().toString(36).slice(-6);
const joiner = {
  employeeId: `TEST-${stamp}`,
  name: 'Test Joiner',
  email: `test.joiner.${stamp}@konecta.example`,
  role: 'ADVISOR',
  managerId: (await call('GET','/people',TL)).body.people.find((p)=>p.role==='TEAM_LEADER')?.id ?? null,
  projectId: null,
  departmentCode: '10000',
  shiftRule: 'CR1',
  hireDate: day(1),
  region: 'EMEA',
};

check('a team leader cannot create a person', (await call('POST','/people',TL,joiner)).status === 403);
check('an advisor cannot create a person', (await call('POST','/people',ADV,joiner)).status === 403);

const created = await call('POST','/people',OM,joiner);
check('an ops manager can create an advisor', created.status === 201, `status ${created.status} ${created.raw?.slice(0,120)}`);
const newId = created.body?.id;
check('creation returns a temporary password once', typeof created.body?.temporaryPassword === 'string' && created.body.temporaryPassword.length >= 12);
check('the temporary password is dictatable', /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(created.body?.temporaryPassword ?? ''));

check('a duplicate email is refused', (await call('POST','/people',OM,{...joiner, employeeId:`OTHER-${stamp}`})).status === 409);
check('a duplicate employee id is refused', (await call('POST','/people',OM,{...joiner, email:`other.${stamp}@konecta.example`})).status === 409);
const noManager = await call('POST','/people',OM,{...joiner, employeeId:`NM-${stamp}`, email:`nm.${stamp}@konecta.example`, managerId:null});
check('an advisor with no manager is refused', noManager.status === 400);
check('and says why, in words', (noManager.body?.problems ?? []).some((p)=>/manager/i.test(p)));
check('an ops manager cannot mint an administrator',
  (await call('POST','/people',OM,{...joiner, employeeId:`AD-${stamp}`, email:`ad.${stamp}@konecta.example`, role:'ADMIN'})).status === 403);

// The new account can sign in and do nothing else until it chooses a password.
const tempTok = (await call('POST','/auth/login',null,{email:joiner.email,password:created.body?.temporaryPassword})).body?.token;
check('the new account can sign in', !!tempTok);
check('but cannot reach anything else yet', (await call('GET','/clock',tempTok)).status === 403);
check('and is told to change its password', (await call('GET','/clock',tempTok)).body?.mustChangePassword === true);
check('it can still read its own identity', (await call('GET','/auth/me',tempTok)).status === 200);
check('which reports the password must change', (await call('GET','/auth/me',tempTok)).body?.user?.mustChangePassword === true);

check('a weak new password is refused',
  (await call('POST','/auth/password',tempTok,{currentPassword:created.body?.temporaryPassword,newPassword:'short'})).status === 400);
check('a wrong current password is refused',
  (await call('POST','/auth/password',tempTok,{currentPassword:'NOPE-NOPE-NOPE',newPassword:'a good long phrase'})).status === 403);
const changed = await call('POST','/auth/password',tempTok,{currentPassword:created.body?.temporaryPassword,newPassword:'a good long phrase'});
check('a decent password is accepted', changed.status === 200, `status ${changed.status}`);
check('and the account is released', (await call('GET','/clock',tempTok)).status === 200);
check('the old temporary password no longer works',
  (await call('POST','/auth/login',null,{email:joiner.email,password:created.body?.temporaryPassword})).status === 401);
check('the chosen one does',
  (await call('POST','/auth/login',null,{email:joiner.email,password:'a good long phrase'})).status === 200);

// Movers.
const otherTL = (await call('GET','/people',OM)).body.people.find((p)=>p.role==='TEAM_LEADER' && p.id !== joiner.managerId);
if (otherTL) {
  check('an ops manager can move somebody to another team',
    (await call('PATCH',`/people/${newId}`,OM,{managerId:otherTL.id})).status === 200);
  check('the move shows in the directory',
    (await call('GET','/people',OM)).body.people.find((p)=>p.id===newId)?.manager_id === otherTL.id);
} else check('only one team leader, so the move check is skipped', true);
check('a reporting loop is refused',
  (await call('PATCH',`/people/${newId}`,OM,{managerId:newId})).status === 400);
check('nobody can change their own role',
  (await call('PATCH',`/people/${(await call('GET','/auth/me',OM)).body.user.id}`,OM,{role:'ADMIN'})).status === 403);
check('an ops manager cannot promote anybody to administrator',
  (await call('PATCH',`/people/${newId}`,OM,{role:'ADMIN'})).status === 403);

// Leavers. The last working day is still a working day.
const lastDay = day(0);
const left = await call('POST',`/people/${newId}/leave`,OM,{leaveDate:lastDay});
check('a leaving date can be recorded', left.status === 200, `status ${left.status}`);
check('the leaver still has access on their last day',
  (await call('POST','/auth/login',null,{email:joiner.email,password:'a good long phrase'})).status === 200);
const yesterdayLeaver = await call('POST',`/people/${newId}/leave`,OM,{leaveDate:day(-1)});
check('a leaving date in the past can be recorded', yesterdayLeaver.status === 200);
check('and access stops the morning after',
  (await call('POST','/auth/login',null,{email:joiner.email,password:'a good long phrase'})).status === 403);
check('an existing token stops working too',
  (await call('GET','/clock',tempTok)).status === 403);
check('the directory reports them as left',
  (await call('GET','/people',OM)).body.people.find((p)=>p.id===newId)?.effective_status === 'TERMINATED');

check('reinstating restores access', (await call('POST',`/people/${newId}/reinstate`,OM)).status === 200);
check('and they can sign in again',
  (await call('POST','/auth/login',null,{email:joiner.email,password:'a good long phrase'})).status === 200);

// A leaver with people still under them would take a whole team out of view,
// so offboarding is refused until they are moved. Found by looking for a
// manager somebody actually reports to rather than assuming a role has reports.
const directory = (await call('GET','/people',OM)).body.people;
const managerIds = new Set(directory.map((p) => p.manager_id).filter(Boolean));
const withReports = directory.find((p) => managerIds.has(p.id) && p.role !== 'ADMIN');
if (withReports) {
  const blocked = await call('POST',`/people/${withReports.id}/leave`,ADM,{leaveDate:day(30)});
  check('a manager with reports cannot be offboarded until they are moved',
    blocked.status === 409, `status ${blocked.status}`);
  check('and it names the people who would be stranded',
    Array.isArray(blocked.body?.problems) && blocked.body.problems.length > 0);
} else check('no manager with reports found, so the stranding check is skipped', true);

// Password reset by an administrator.
const reset = await call('POST',`/people/${newId}/reset-password`,OM);
check('an ops manager can reset a password', reset.status === 200);
check('which returns a new temporary password', /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(reset.body?.temporaryPassword ?? ''));
check('the reset account is locked to the password screen again',
  (await call('GET','/clock',(await call('POST','/auth/login',null,{email:joiner.email,password:reset.body?.temporaryPassword})).body?.token)).status === 403);
check('an advisor cannot reset somebody else\'s password',
  (await call('POST',`/people/${newId}/reset-password`,ADV)).status === 403);

// Lockout. Five wrong guesses in a row buys a delay, not a locked door.
const lockEmail = `lock.${stamp}@konecta.example`;
const lockable = await call('POST','/people',OM,{...joiner, employeeId:`LK-${stamp}`, email:lockEmail});
if (lockable.status === 201) {
  for (let i = 0; i < 5; i++) await call('POST','/auth/login',null,{email:lockEmail,password:'definitely-wrong'});
  const locked = await call('POST','/auth/login',null,{email:lockEmail,password:lockable.body.temporaryPassword});
  check('five wrong guesses locks the account briefly', locked.status === 429, `status ${locked.status}`);
  check('and says how long to wait', /minute/.test(locked.body?.error ?? ''));
  check('the lock is a delay, not a door', /try again/i.test(locked.body?.error ?? ''));
} else check('lockout account could not be created, check skipped', false, `status ${lockable.status}`);

check('a wrong password and an unknown address are indistinguishable',
  (await call('POST','/auth/login',null,{email:'admin@konecta.example',password:'wrong'})).body?.error ===
  (await call('POST','/auth/login',null,{email:`ghost.${stamp}@nowhere.example`,password:'wrong'})).body?.error);

console.log('=== SPA ROUTING ===');
for (const p of ['/dashboard','/admin/audit','/reports/query','/my']) {
  const res = await fetch(ORIGIN + p, { headers: { accept: 'text/html' } });
  check(`page load ${p} serves the app`, res.headers.get('content-type')?.includes('text/html'), `got ${res.headers.get('content-type')}`);
}

console.log(`\n${'='.repeat(46)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  ✗ ' + f)); }
process.exit(fail > 0 ? 1 : 0);
