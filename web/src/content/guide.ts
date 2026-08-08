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

/**
 * What one role is doing on one screen.
 *
 * The tab guidance answers "what is this screen for"; this answers "what is it
 * for *me*". They are genuinely different questions — a Team Leader opens Time
 * & Attendance to clear yesterday inside a three day window, an Operations
 * Manager opens the same screen to make a post-payroll correction six weeks
 * back, and an Advisor opens it to check they were paid. Telling all three the
 * same thing is how a guide gets ignored.
 */
export interface RoleTabNote {
  /** One sentence: why this role is on this screen. */
  focus: string;
  /** Moves specific to this role, where they differ from the general steps. */
  steps?: GuideStep[];
  /** Mistakes this role in particular makes here. */
  watchFor?: string[];
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


/**
 * Per-role notes, keyed by the tab's route.
 *
 * Kept beside the tab guidance rather than inside it so that adding a role's
 * note is a small, local edit — the whole point being that this is expected to
 * be revised as people use the tool and tell you what they actually got stuck
 * on.
 */
export const ROLE_TAB_NOTES: Record<string, Partial<Record<Role, RoleTabNote>>> = {
  '/dashboard': {
    ADVISOR: {
      focus: 'Clock on, change activity, clock off. This screen is your timesheet as it happens.',
      steps: [
        {
          title: 'Clock on when your shift starts',
          body: 'The button only opens inside your scheduled window. If it is greyed out you are either early, or you have no shift — and no shift is a scheduling problem, not a clock problem.',
        },
        {
          title: 'Change activity rather than clocking off',
          body: 'Break, lunch, training, meeting — change to it. Clocking off ends your shift, and a shift ended by mistake becomes a correction somebody else has to make.',
        },
      ],
      watchFor: [
        'Once you go on an unpaid meal you cannot return to a paid activity until the full meal duration has passed. That is the rule, not a bug.',
      ],
    },
    TEAM_LEADER: {
      focus: 'Know where your team is right now, and clear the things that are still fixable today.',
      steps: [
        {
          title: 'Work the alert list first',
          body: 'Late, left early, over their break. Every one of these is recoverable while the shift is running and becomes an exception on a timecard once it is not.',
        },
        {
          title: 'A no-show is not a late',
          body: 'Somebody who never clocked on is a cover problem, not a chase. The board separates the two so you spend your morning on the right one.',
        },
      ],
      watchFor: [
        'Live adherence counts only people on shift right now. It is not the daily figure in Reports and the two will not match.',
      ],
    },
    TRAINER: {
      focus: 'Your class, and whether they are clocking on correctly while they learn to.',
      watchFor: [
        'New hires get the clocking wrong far more than they get the work wrong. A cluster of Late on your board is usually a training gap, not an attendance problem.',
      ],
    },
    OPS_MANAGER: {
      focus: 'Cover against forecast across every team, and whether today is going to hold.',
      steps: [
        {
          title: 'Read the coverage chart before the board',
          body: 'The board tells you who; the chart tells you whether it matters. Short intervals with a real forecast behind them are what you can still act on.',
        },
      ],
    },
    ADMIN: {
      focus: 'A whole-estate view. Mostly you are here to confirm the system is reflecting reality.',
    },
  },

  '/time': {
    ADVISOR: {
      focus: 'Check what you were actually paid for. You can read your cards; you cannot change them.',
      watchFor: [
        'If a card is wrong, tell your Team Leader rather than waiting. Their window to fix it without escalation is three days.',
      ],
    },
    TEAM_LEADER: {
      focus: 'Clear yesterday. Your edit window is three days and it is the shortest of anyone’s.',
      steps: [
        {
          title: 'Sort to what needs reading',
          body: 'Cards with exceptions are the ones worth opening. Everything else is a checkbox, which is exactly what “Approve N clean” is for.',
        },
        {
          title: 'Approve deliberately',
          body: 'Approval is what sends the day to payroll. Bulk approval refuses anything carrying an exception precisely so those stay a decision you make.',
        },
      ],
      watchFor: [
        'Past three days the card is no longer yours. It goes to your Operations Manager, and that is a conversation, not a form.',
      ],
    },
    TRAINER: {
      focus: 'Your trainees’ cards, with six days to correct them.',
      watchFor: [
        'Training time is paid and productive but not phone time. A trainee card that looks like poor adherence is usually a schedule that says phones when the class says otherwise.',
      ],
    },
    OPS_MANAGER: {
      focus: 'Everything the Team Leaders could not reach, and any correction after payroll has run.',
      steps: [
        {
          title: 'Post-payroll corrections',
          body: 'Editing a card past its protect date does not change the run that already happened. It transfers on the next one, and the card says so.',
        },
      ],
      watchFor: [
        'Forty-four days is a long window. The fact that you *can* edit a card from six weeks ago is not a reason to; ask why it was missed.',
      ],
    },
    ADMIN: {
      focus: 'A year of edit window, which exists for data repair rather than day-to-day correction.',
      watchFor: ['Every edit is attributable in the audit trail. Yours especially.'],
    },
  },

  '/scheduling': {
    TEAM_LEADER: {
      focus: 'Day-to-day changes to your own team’s shifts, and dropping one exception across the group at once.',
      steps: [
        {
          title: 'Times are authoritative, dates follow',
          body: 'Type the time; the tool works out which day it lands on. That is what keeps an overnight shift on one payroll date.',
        },
      ],
      watchFor: [
        'A group exception that falls outside somebody’s shift is skipped and reported. It never silently moves their shift — read the skipped list.',
      ],
    },
    TRAINER: {
      focus: 'Putting class time on the schedule so trainee adherence is measured against the right plan.',
    },
    OPS_MANAGER: {
      focus: 'Forecast and coverage. This is where the roster gets decided rather than repaired.',
      steps: [
        {
          title: 'Cover the gap, then check the cost',
          body: 'Auto-schedule drafts shifts into the worst-covered intervals. Look at projected service level and occupancy afterwards — occupancy above about 85% is a warning, not an achievement.',
        },
      ],
      watchFor: [
        'The staffing model assumes one queue. If the work is genuinely multi-skilled, treat the required headcount as optimistic.',
      ],
    },
    ADMIN: { focus: 'You have access; ordinarily this is not your screen.' },
  },

  '/my': {
    ADVISOR: {
      focus: 'Everything you can arrange about your own time without asking anybody in person.',
      steps: [
        {
          title: 'Time off is checked as you submit',
          body: 'You cannot request more than you have accrued. The balance only moves when it is approved, not when you ask.',
        },
        {
          title: 'A swap needs three yeses',
          body: 'You, your colleague, then a supervisor. Nothing moves on your schedule until the third one.',
        },
        {
          title: 'Extra hours are bid for, not claimed',
          body: 'Bidding puts your hand up. Winning it puts the block on your schedule, which is what lets you clock on for it at all.',
        },
      ],
    },
    TEAM_LEADER: {
      focus: 'The approvals queue: swaps your team agreed between themselves, and extra hours to award.',
      watchFor: [
        'Approving a swap exchanges the schedules immediately and re-derives both timecards. Check neither person ends up scheduled twice.',
        'Approving leave does not check coverage for you. Look at the day before you say yes.',
      ],
    },
    OPS_MANAGER: {
      focus: 'Leave liability and whether extra hours are covering real gaps or just costing money.',
    },
  },

  '/admin': {
    TEAM_LEADER: {
      focus: 'Custom groups for the people you actually work with, and an alternate for when you are away.',
      steps: [
        {
          title: 'Assign an alternate before you go on leave',
          body: 'They see your team and your groups for as long as it stands. Without one, your team has nobody inside the three day window.',
        },
      ],
      watchFor: ['You get one alternate at a time. Remove the current one before assigning another.'],
    },
    TRAINER: { focus: 'Mostly the roster of who is in your class and what their records say.' },
    OPS_MANAGER: {
      focus: 'Shift rules, which decide how lateness and meals are judged for everybody under them.',
      watchFor: [
        'A rule change can only take effect from a future date. That is deliberate — it stops a change rewriting how time already worked was judged.',
      ],
    },
    ADMIN: {
      focus: 'Everything, plus the audit trail — which is the point of the tab.',
      steps: [
        {
          title: 'The audit trail is the record',
          body: 'Timecards are financial documents. Every schedule edit, timecard edit and approval is attributable, and this is where you attribute it.',
        },
      ],
    },
  },

  '/reports': {
    ADVISOR: {
      focus: 'Your own day: what was planned against what happened.',
      watchFor: [
        '“Worth asking about” is a prompt for a conversation, not an accusation. If it says something you can explain, explain it.',
      ],
    },
    TEAM_LEADER: {
      focus: 'One advisor, one day, before you have the conversation about it.',
      steps: [
        {
          title: 'Read the bar before the numbers',
          body: 'Green is time spent doing what was planned. The shape tells you whether the day drifted or broke, which is a different conversation.',
        },
      ],
    },
    TRAINER: { focus: 'Whether a trainee’s week is improving, which is a trend rather than a day.' },
    OPS_MANAGER: {
      focus: 'Analytics: the pattern across a fortnight rather than the incident on a Tuesday.',
      steps: [
        {
          title: 'Scorecards are sorted by exception count',
          body: 'The top of that list is where a conversation is due. One exception is an incident; a column of them is a pattern.',
        },
        {
          title: 'Shrinkage tells you where the hours went',
          body: 'Paid time off the phone, by activity. It is the number that explains why the roster looked sufficient and the service level was not.',
        },
      ],
    },
    ADMIN: { focus: 'The query tool, for the questions no fixed report answers.' },
  },
};

/** The note for a role on a screen, if there is one worth showing. */
export function roleNoteFor(pathname: string, role: string): RoleTabNote | undefined {
  const guide = guideForPath(pathname);
  if (!guide) return undefined;
  return ROLE_TAB_NOTES[guide.path]?.[role as Role];
}
