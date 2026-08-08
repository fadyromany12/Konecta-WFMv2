/**
 * The in-app guide.
 *
 * Written to be read at the moment someone is stuck, which is why each section
 * leads with what the screen is *for* rather than what the controls are called.
 * The things labelled "watch for" are the mistakes that are expensive and
 * invisible — a timecard that silently pays nothing, a shift entered on the
 * wrong date — rather than everything that could theoretically go wrong.
 */

export type Role = 'ADVISOR' | 'TEAM_LEADER' | 'TRAINER' | 'OPS_MANAGER' | 'ADMIN';

export interface GuideStep {
  title: string;
  body: string;
}

export interface TabGuide {
  /** Route prefix this guidance belongs to. */
  path: string;
  tab: string;
  /** One sentence: what this screen is for. */
  purpose: string;
  /** When in the day you would open it. */
  whenToUse: string;
  audience: Role[];
  steps: GuideStep[];
  watchFor: string[];
}

export interface RoleGuide {
  role: Role;
  label: string;
  oneLine: string;
  /** The routine this role actually works to. */
  routine: string[];
  canDo: string[];
  cannotDo: string[];
}

export const ROLE_GUIDES: RoleGuide[] = [
  {
    role: 'ADVISOR',
    label: 'Advisor',
    oneLine: 'You record your own time and arrange your own shifts.',
    routine: [
      'Clock on from the Dashboard when your shift starts — you can only clock on inside your scheduled window.',
      'Change activity whenever what you are doing changes: break, lunch, training, back to the phone.',
      'Clock off at the end. If you forget, the system assumes your scheduled end and flags it for your Team Leader.',
      'Check the Pulse Report the next morning to see your own day back, and raise anything that looks wrong.',
    ],
    canDo: [
      'Clock on, change activity and clock off',
      'See your own timecards, schedule and adherence',
      'Request time off against your accrued balance',
      'Offer a shift swap to a colleague and bid for extra hours',
    ],
    cannotDo: [
      'Edit a timecard — including your own. Corrections go to your Team Leader, with a timekeeping correction form where your region requires one.',
      'See anybody else’s timecards or schedules',
      'Return to a paid activity before your meal duration has elapsed',
    ],
  },
  {
    role: 'TEAM_LEADER',
    label: 'Team Leader',
    oneLine: 'You run the shift in front of you and own your team’s timecards.',
    routine: [
      'Open the Dashboard first. Anyone late or not clocked on is still recoverable at this point.',
      'Work the alert list — a missing clock-on at 09:10 is a phone call; the same fact tomorrow is paperwork.',
      'Mid-morning, read yesterday’s Pulse Report for each advisor with an exception.',
      'Correct schedules first, then timecards — the card is derived from the plan, so fixing the plan fixes most of it.',
      'Approve timecards daily. Your edit window is three days; past that it becomes your Operations Manager’s problem.',
    ],
    canDo: [
      'Edit schedules and timecards for your team, up to 3 days back',
      'Approve timecards',
      'Apply a group exception across the whole team at once',
      'Approve time off, shift swaps and extra-hours bids',
      'Build custom groups and delegate your team to an alternate',
    ],
    cannotDo: [
      'Edit a timecard older than 3 days — escalate to your Operations Manager',
      'Edit an approved timecard without removing the approval first',
      'Change a shift rule with effect from today or earlier; rule changes are future-dated only',
    ],
  },
  {
    role: 'TRAINER',
    label: 'Trainer',
    oneLine: 'Same tools as a Team Leader, with a longer reach for new starters.',
    routine: [
      'Check your class is clocked on and against training activities, not phone codes.',
      'Correct the first days of a new hire’s timecards — they often are not in the system on day one or two.',
      'Hand the class over to their Team Leader with clean cards before they hit production.',
    ],
    canDo: [
      'Everything a Team Leader can, for the advisors reporting to you',
      'Edit timecards up to 6 days back, rather than 3',
    ],
    cannotDo: [
      'Edit beyond 6 days — the extended window exists for new-hire lag, not for catching up on old work',
    ],
  },
  {
    role: 'OPS_MANAGER',
    label: 'Operations Manager',
    oneLine: 'You own the numbers, the plan, and the corrections your Team Leaders cannot make.',
    routine: [
      'Start on the Dashboard across the whole reporting line, not one team.',
      'Take the escalations: anything outside a Team Leader’s three-day window lands with you.',
      'Review the forecast against the roster for the coming week and close gaps before they become a service failure.',
      'Read Analytics weekly — a pattern of exceptions is a coaching conversation, not an edit.',
      'Run payroll for the period, which protects the cards and turns later edits into corrections.',
    ],
    canDo: [
      'Everything a Team Leader can, across every team reporting to you',
      'Edit timecards up to 44 days back',
      'Run payroll and set the protect date',
      'Set the service goal, answer threshold and shrinkage used for planning',
    ],
    cannotDo: [
      'Undo a payroll run — a card inside a protected period can still be edited, but it becomes a post-payroll correction on a later run',
    ],
  },
  {
    role: 'ADMIN',
    label: 'System Administrator',
    oneLine: 'You see everything and are the last resort, not the first.',
    routine: [
      'Handle access and profile problems: no timekeeping activities usually means a wrong project or department code.',
      'Use the audit trail to answer who changed what and when.',
      'Leave day-to-day corrections to the people who own the shift.',
    ],
    canDo: ['Everything, across every project and team', 'Read the full audit trail'],
    cannotDo: [
      'Nothing is blocked — which is exactly why routine edits should be made by the supervisor who owns the team, so the audit trail reads correctly',
    ],
  },
];

export const TAB_GUIDES: TabGuide[] = [
  {
    path: '/dashboard',
    tab: 'Dashboard',
    purpose:
      'The only screen that shows now. Everything else in the tool looks backwards; this is the window in which you can still change today’s outcome.',
    whenToUse: 'First thing on shift, and any time you want to know where your team actually is.',
    audience: ['ADVISOR', 'TEAM_LEADER', 'TRAINER', 'OPS_MANAGER', 'ADMIN'],
    steps: [
      {
        title: 'Advisors see the web clock',
        body: 'Clock on, change activity, clock off. The clock only opens inside your scheduled window, and it will not let you return to a paid activity until your meal duration has actually passed.',
      },
      {
        title: 'Supervisors see the live board',
        body: 'Every advisor on shift, colour-coded by what they are doing right now. The left edge carries the state so the board scans by colour rather than by reading.',
      },
      {
        title: 'Work the alert list',
        body: '“Needs attention” only lists things still fixable today — someone late, someone who left early, someone well over their break. Clear it and the day is under control.',
      },
      {
        title: 'Check cover against forecast',
        body: 'Bars are rostered headcount, the line is what the forecast asks for. Magenta bars are intervals where you are short. Open planning to do something about it.',
      },
    ],
    watchFor: [
      'The board refreshes every 30 seconds. If a number looks stale, it is at most half a minute old.',
      'Live adherence counts only people currently on shift — it is not the same number as the daily adherence in reports.',
    ],
  },
  {
    path: '/time',
    tab: 'Time & Attendance',
    purpose:
      'Where timecards are reviewed, corrected and approved. Timecards are financial documents: they drive payroll, client billing and project metrics.',
    whenToUse: 'Daily. A card reviewed the next morning is cheap to fix; one found a fortnight later may not be fixable at all.',
    audience: ['ADVISOR', 'TEAM_LEADER', 'TRAINER', 'OPS_MANAGER', 'ADMIN'],
    steps: [
      {
        title: 'Start at the Payroll Summary',
        body: 'One row per timecard. The Codes column tells you what happened without opening anything — LT, LE, LLU, NCS are worth a look; (W), BRK and LUN are a normal day.',
      },
      {
        title: 'Open a card that needs work',
        body: 'The editor shows the payroll shift detail and the scheduled shift side by side, so you can see what was planned while you correct what was recorded.',
      },
      {
        title: 'Fix the schedule first where it is wrong',
        body: 'Most exceptions come from the plan being wrong rather than the advisor. Correct the schedule and rebuild the card from punches, and the exception usually disappears on its own.',
      },
      {
        title: 'Approve',
        body: 'Tick Approved on the summary, or use the button on the card. An approved card is locked until the approval is removed.',
      },
    ],
    watchFor: [
      'Changing a code is not enough on its own. Turning a Long Lunch into Worked while leaving the activity on 99-001 leaves the advisor unpaid — the tool refuses that pairing, but it is the mistake to know about.',
      'Delete a row and you must account for the time. Gaps and overlaps are both refused, with the exact size and position.',
      'Adjacent rows sharing a code, project and activity merge on save. A corrected row appearing to vanish is expected, not lost.',
      'Your edit window is per role: Team Leader 3 days, Trainer 6, Operations Manager 44.',
    ],
  },
  {
    path: '/scheduling',
    tab: 'Scheduling',
    purpose:
      'The plan: individual schedules, group-wide exceptions, and the forecast that says how many people the plan needs.',
    whenToUse:
      'Intraday for corrections, and ahead of the week for planning. Publish schedules before the day, not during it.',
    audience: ['TEAM_LEADER', 'TRAINER', 'OPS_MANAGER', 'ADMIN'],
    steps: [
      {
        title: 'Edit Advisor Schedule',
        body: 'A row is a start time plus an activity; it runs until the next row starts. Insert Row Above, Delete Row and Add Shift cover almost every real edit. Type times as four digits — 0500 becomes 05:00.',
      },
      {
        title: 'Group Schedule Exceptions',
        body: 'Drop one activity — a team meeting, a focus group — across everybody at once. Anyone whose shift does not contain that time is skipped and told why, rather than having their shift quietly moved.',
      },
      {
        title: 'Forecast & Coverage',
        body: 'Contact volume and handling time produce a required headcount through an Erlang C model, compared against what is rostered. Auto-schedule drafts shifts into the deepest gap first.',
      },
    ],
    watchFor: [
      'A shift must be entered on the date it starts. An overnight shift beginning at 23:00 belongs to that evening’s date, not the following morning’s — get this wrong and the advisor cannot clock on at all.',
      'Times are authoritative and dates follow from them. Type 02:30 into a 23:00 shift and it correctly lands on the next morning.',
      'Extra Hours are pre-approved additional hours to meet staffing. Flex Up is unplanned and needs an Operations Manager. They are not interchangeable — Workforce Management plans from the difference.',
      'Occupancy above about 85% in the coverage table is a warning, not an achievement: it means no recovery time between contacts.',
    ],
  },
  {
    path: '/my',
    tab: 'My Shifts',
    purpose: 'Everything you arrange about your own time — and, if you supervise, the approvals that go with it.',
    whenToUse: 'Whenever you need time off, want to swap a shift, or want extra hours.',
    audience: ['ADVISOR', 'TEAM_LEADER', 'TRAINER', 'OPS_MANAGER', 'ADMIN'],
    steps: [
      {
        title: 'Time Off',
        body: 'Requests are checked against your accrued balance as you submit, so you cannot book leave you have not earned. The balance only moves when a supervisor approves.',
      },
      {
        title: 'Shift Swaps',
        body: 'Offer one of your shifts and take one of theirs. The colleague accepts, then a supervisor approves — and it is the approval that actually exchanges the two schedules.',
      },
      {
        title: 'Extra Hours',
        body: 'Supervisors post blocks with a number of slots; advisors bid. Awarding a bid adds the block to that advisor’s schedule, which is what lets them clock on for it.',
      },
    ],
    watchFor: [
      'A swap needs three yeses: you, your colleague, and a supervisor. Nothing moves until all three.',
      'You cannot swap onto a day you are already scheduled — the tool checks both sides before accepting the request.',
    ],
  },
  {
    path: '/admin',
    tab: 'Admin',
    purpose: 'Who you can see, how their shifts are judged, who covers for you, and what everyone has changed.',
    whenToUse: 'When access looks wrong, when covering for a peer, or when you need to answer “who did this?”.',
    audience: ['TEAM_LEADER', 'TRAINER', 'OPS_MANAGER', 'ADMIN'],
    steps: [
      {
        title: 'Details of Who',
        body: 'Everyone you can see, and the groups they fall into. Tick rows and save to build a custom group for a subset of your team.',
      },
      {
        title: 'Supervisor Admin',
        body: 'Shift rules set the grace either side of a shift and the enforced meal duration. Changes are future-dated only.',
      },
      {
        title: 'Alternate Team Leader',
        body: 'Delegate your team while you are away. Your alternate sees your advisors and your custom groups until you remove them.',
      },
      {
        title: 'Audit Trail',
        body: 'Every schedule edit, timecard edit, approval, punch and payroll run, with who did it.',
      },
    ],
    watchFor: [
      'Group prefixes tell you where a group came from: -- from the reporting hierarchy, - your own, ALT_ delegated to you.',
      'You can have exactly one alternate at a time. Remove the current one before assigning another.',
      'An advisor with no timekeeping activities almost always has a wrong project or department code, not a broken account.',
    ],
  },
  {
    path: '/reports',
    tab: 'Reports',
    purpose: 'Yesterday and further back: what was planned against what happened, and the patterns across it.',
    whenToUse: 'The Pulse Report daily. Analytics weekly, before one-to-ones.',
    audience: ['ADVISOR', 'TEAM_LEADER', 'TRAINER', 'OPS_MANAGER', 'ADMIN'],
    steps: [
      {
        title: 'Pulse Report',
        body: 'One advisor, one day: schedule against reality, with an adherence bar and the questions worth asking. Read this before correcting anything.',
      },
      {
        title: 'Analytics',
        body: 'The same timecards across time. Scorecards sort by exception count, so the top of the list is where a conversation is due. Exports to CSV.',
      },
      {
        title: 'Non-Worked Exceptions',
        body: 'Every exception code across a group and range — the fastest way to see where supervisor time is going.',
      },
      {
        title: 'Query Tool',
        body: 'Ad-hoc slice across timecard rows for the questions no fixed report answers.',
      },
    ],
    watchFor: [
      '“Worth asking about” is a prompt for a conversation, not a verdict. An advisor took a break early may have been told to.',
      'One exception is an incident; a pattern is a coaching conversation. Analytics is where you tell the two apart.',
    ],
  },
];

/**
 * Getting around, as distinct from getting work done.
 *
 * These apply on every screen, so they are shown alongside whichever tab guide
 * is open rather than buried in one of them.
 */
export const GETTING_AROUND: GuideStep[] = [
  {
    title: 'Search anything with ⌘K',
    body:
      'Ctrl-K off a Mac. Type a screen name, or an advisor’s name or employee ID to open their Pulse Report or ' +
      'schedule directly — it saves picking a group and then a person on arrival.',
  },
  {
    title: 'The bell shows what happened while you were away',
    body:
      'Late starts, swap requests waiting on you, extra hours awarded, schedule changes. The small dot under the ' +
      'bell is lit when the app has a live connection; when it is grey the screens are refreshing on a timer instead, ' +
      'which is slower but not wrong.',
  },
  {
    title: 'Confirmations appear bottom right',
    body:
      'Anything you save says so there. A refusal stays until you dismiss it — if you did not see a message, the ' +
      'action succeeded quietly.',
  },
  {
    title: 'Press ? for this guide, Esc to close',
    body: 'The guide always opens on the screen you are looking at.',
  },
];

/** The guidance for whichever screen the user is on. */
export function guideForPath(pathname: string): TabGuide | undefined {
  return TAB_GUIDES.find((g) => pathname.startsWith(g.path));
}

export function roleGuide(role: string): RoleGuide | undefined {
  return ROLE_GUIDES.find((g) => g.role === role);
}
