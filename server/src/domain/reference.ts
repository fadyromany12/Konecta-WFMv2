/**
 * Reference data: roles, edit windows, timecard codes and activity codes.
 *
 * These mirror the operating model the tool enforces. Activity codes are
 * `NN-NNN` where the prefix groups the family (01 phone, 07 phone extra hours,
 * 16 coaching, 26 break, 99 unpaid lunch, ...). Timecards refer to activities by
 * number only, so every screen resolves the description from this catalogue.
 */

export const PRODUCT = {
  name: 'Konecta Pulse',
  acronym: 'Planning · Utilization · Labor · Scheduling · Exceptions',
  short: 'Pulse',
};

export const ROLES = ['ADVISOR', 'TEAM_LEADER', 'TRAINER', 'OPS_MANAGER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  ADVISOR: 'Advisor',
  TEAM_LEADER: 'Team Leader',
  TRAINER: 'Trainer',
  OPS_MANAGER: 'Operations Manager',
  ADMIN: 'System Administrator',
};

/**
 * How far back each role may edit a timecard, counted in days before today.
 * Timecards are financial documents: the window keeps late edits from missing
 * the metric and client billing cycles they feed. A Team Leader who needs an
 * older edit escalates to their Operations Manager, which is exactly the point
 * — it forces the conversation about why the edit is late.
 */
export const EDIT_WINDOW_DAYS: Record<Role, number> = {
  ADVISOR: 0,
  TEAM_LEADER: 3,
  TRAINER: 6,
  OPS_MANAGER: 44,
  ADMIN: 365,
};

/** Roles allowed to approve a payroll record. */
export const APPROVER_ROLES: Role[] = ['TEAM_LEADER', 'TRAINER', 'OPS_MANAGER', 'ADMIN'];

/** Roles that can see and manage other people's records at all. */
export const SUPERVISOR_ROLES: Role[] = ['TEAM_LEADER', 'TRAINER', 'OPS_MANAGER', 'ADMIN'];

export interface TimecardCode {
  code: string;
  name: string;
  paid: boolean;
  /** An exception is anything that is not plain worked time — it drives review. */
  exception: boolean;
  description: string;
}

export const TIMECARD_CODES: TimecardCode[] = [
  { code: '(W)', name: 'Worked', paid: true, exception: false, description: 'Productive worked time.' },
  { code: 'BRK', name: 'Break', paid: true, exception: false, description: 'Paid rest break.' },
  { code: 'LUN', name: 'Lunch', paid: false, exception: false, description: 'Unpaid meal period.' },
  { code: 'LLU', name: 'Long Lunch', paid: false, exception: true, description: 'Meal period exceeded its scheduled duration.' },
  { code: 'LB', name: 'Long Break', paid: true, exception: true, description: 'Rest break exceeded its scheduled duration.' },
  { code: 'LT', name: 'Late', paid: false, exception: true, description: 'Clocked on after the scheduled shift start.' },
  { code: 'LE', name: 'Leave Early', paid: false, exception: true, description: 'Clocked off before the scheduled shift end.' },
  { code: 'ABS', name: 'Absence', paid: false, exception: true, description: 'Scheduled time not worked.' },
  { code: 'NCS', name: 'No Call No Show', paid: false, exception: true, description: 'Entire shift missed with no notification.' },
  { code: 'MAA', name: 'Management Approved Absence', paid: false, exception: true, description: 'Absence authorised in advance by management.' },
  { code: 'UTO', name: 'Unpaid Time Off', paid: false, exception: true, description: 'Approved unpaid time off.' },
  { code: 'PTO', name: 'Paid Time Off', paid: true, exception: true, description: 'Approved paid time off drawn from accruals.' },
  { code: 'SCK', name: 'Sick', paid: true, exception: true, description: 'Sick time drawn from accruals.' },
  { code: 'EXH', name: 'Extra Hours', paid: true, exception: false, description: 'Pre-approved additional hours offered to augment staffing.' },
  { code: 'FLXU', name: 'Flex Up', paid: true, exception: true, description: 'Unplanned additional hours; needs Operations Manager approval.' },
  { code: 'FLXD', name: 'Flex Down', paid: true, exception: true, description: 'Advisor pulled offline to protect line adherence, still working.' },
  { code: 'OT', name: 'Overtime', paid: true, exception: false, description: 'Hours paid at an overtime premium.' },
];

export const CODE_MAP = new Map(TIMECARD_CODES.map((c) => [c.code, c]));

export interface ActivityCode {
  code: string;
  name: string;
  paid: boolean;
  /** Productive activities count toward occupancy; the rest are shrinkage. */
  productive: boolean;
  family: string;
  /** Default timecard code applied when an advisor punches into this activity. */
  defaultCode: string;
}

export const ACTIVITIES: ActivityCode[] = [
  { code: '01-001', name: 'INBOUND Phone Time', paid: true, productive: true, family: 'Phone', defaultCode: '(W)' },
  { code: '01-002', name: 'OUTBOUND Phone Time', paid: true, productive: true, family: 'Phone', defaultCode: '(W)' },
  { code: '02-001', name: 'Back Office / Case Work', paid: true, productive: true, family: 'Back Office', defaultCode: '(W)' },
  { code: '03-001', name: 'Chat & Digital', paid: true, productive: true, family: 'Digital', defaultCode: '(W)' },
  { code: '05-001', name: 'Pre-Shift', paid: true, productive: false, family: 'Shift', defaultCode: '(W)' },
  { code: '05-002', name: 'Post-Shift Wrap', paid: true, productive: false, family: 'Shift', defaultCode: '(W)' },
  { code: '07-001', name: 'INBOUND Phone Time EXTRA HOURS', paid: true, productive: true, family: 'Extra Hours', defaultCode: 'EXH' },
  { code: '07-002', name: 'Back Office EXTRA HOURS', paid: true, productive: true, family: 'Extra Hours', defaultCode: 'EXH' },
  { code: '12-001', name: 'Team Meeting', paid: true, productive: false, family: 'Meetings', defaultCode: '(W)' },
  { code: '12-002', name: 'Focus Group', paid: true, productive: false, family: 'Meetings', defaultCode: '(W)' },
  { code: '15-001', name: 'Training', paid: true, productive: false, family: 'Training', defaultCode: '(W)' },
  { code: '15-002', name: 'CE Training', paid: true, productive: false, family: 'Training', defaultCode: '(W)' },
  { code: '16-001', name: 'Coaching/Feedback', paid: true, productive: false, family: 'Coaching', defaultCode: '(W)' },
  { code: '16-003', name: 'Quality Coaching', paid: true, productive: false, family: 'Coaching', defaultCode: '(W)' },
  { code: '20-001', name: 'System Outage', paid: true, productive: false, family: 'Downtime', defaultCode: '(W)' },
  { code: '26-001', name: 'Break', paid: true, productive: false, family: 'Break', defaultCode: 'BRK' },
  { code: '99-001', name: 'Lunch', paid: false, productive: false, family: 'Meal', defaultCode: 'LUN' },
  { code: '99-002', name: 'Unpaid Time Off', paid: false, productive: false, family: 'Absence', defaultCode: 'UTO' },
  { code: '99-003', name: 'Absence', paid: false, productive: false, family: 'Absence', defaultCode: 'ABS' },
  // Paid leave needs a paid activity of its own. Until it had one, the PTO
  // schedule activity pointed at Unpaid Time Off, so a planned day of holiday
  // resolved to unpaid — and the pairing check would have called any timecard
  // row built from it an error.
  { code: '99-004', name: 'Paid Time Off', paid: true, productive: false, family: 'Absence', defaultCode: 'PTO' },
];

export const ACTIVITY_MAP = new Map(ACTIVITIES.map((a) => [a.code, a]));

/** Schedule activities are the plan-side vocabulary shown in the schedule editor. */
export const SCHEDULE_ACTIVITIES = [
  { key: 'SHIFT_START', name: 'Start of Shift', activity: '01-001' },
  { key: 'OPEN_TIME', name: 'Open Time', activity: '01-001' },
  { key: 'BREAK', name: 'Break', activity: '26-001' },
  { key: 'LUNCH', name: 'Lunch', activity: '99-001' },
  { key: 'TRAINING', name: 'Training', activity: '15-001' },
  { key: 'CE_TRAINING', name: 'CE Training', activity: '15-002' },
  { key: 'TEAM_MEETING', name: 'Team Meeting', activity: '12-001' },
  { key: 'FOCUS_GROUP', name: 'Focus Group', activity: '12-002' },
  { key: 'COACHING', name: 'Coaching/Feedback', activity: '16-001' },
  { key: 'QUALITY', name: 'Quality Coaching', activity: '16-003' },
  { key: 'EXTRA_HOURS', name: 'Extra Hours', activity: '07-001' },
  { key: 'FLEX_UP', name: 'Flex Up', activity: '01-001' },
  { key: 'FLEX_DOWN', name: 'Flex Down', activity: '02-001' },
  { key: 'PTO', name: 'Paid Time Off', activity: '99-004' },
  { key: 'UTO', name: 'Unpaid Time Off', activity: '99-002' },
  { key: 'SHIFT_END', name: 'End of Shift', activity: '' },
] as const;

export type ScheduleActivityKey = (typeof SCHEDULE_ACTIVITIES)[number]['key'];

export const SCHEDULE_ACTIVITY_MAP = new Map(SCHEDULE_ACTIVITIES.map((s) => [s.key, s]));

/**
 * Shift rules bound how a shift may be worked — the grace either side of the
 * scheduled start before a Late or Leave Early exception is raised, and the
 * unpaid meal duration the clock enforces before an advisor can return to a
 * productive activity.
 */
export interface ShiftRule {
  code: string;
  name: string;
  lateGraceMinutes: number;
  earlyGraceMinutes: number;
  lunchMinutes: number;
  clockOnLeadMinutes: number;
  description: string;
}

export const SHIFT_RULES: ShiftRule[] = [
  {
    code: 'CR1',
    name: 'Standard — 30 minute meal',
    lateGraceMinutes: 3,
    earlyGraceMinutes: 3,
    lunchMinutes: 30,
    clockOnLeadMinutes: 15,
    description: 'Default rule. 3 minute grace either side, 30 minute unpaid meal.',
  },
  {
    code: 'CR2',
    name: 'Standard — 60 minute meal',
    lateGraceMinutes: 3,
    earlyGraceMinutes: 3,
    lunchMinutes: 60,
    clockOnLeadMinutes: 15,
    description: '3 minute grace either side, 60 minute unpaid meal.',
  },
  {
    code: 'CR3',
    name: 'Flexible start',
    lateGraceMinutes: 10,
    earlyGraceMinutes: 10,
    lunchMinutes: 30,
    clockOnLeadMinutes: 30,
    description: '10 minute grace either side for programmes with a flexible start.',
  },
  {
    code: 'CR4',
    name: 'Zero tolerance',
    lateGraceMinutes: 0,
    earlyGraceMinutes: 0,
    lunchMinutes: 30,
    clockOnLeadMinutes: 5,
    description: 'No grace. Used where the client contract requires strict adherence.',
  },
];

export const SHIFT_RULE_MAP = new Map(SHIFT_RULES.map((r) => [r.code, r]));

export const DEFAULT_SHIFT_RULE = 'CR1';

/** Manual check statuses available on a post-payroll correction. */
export const MANUAL_CHECK_STATUSES = [
  'NONE',
  '3RD_PARTY_REQUEST',
  'ON_SITE_REQUEST',
  'NEXT_CYCLE',
] as const;

export type ManualCheckStatus = (typeof MANUAL_CHECK_STATUSES)[number];
