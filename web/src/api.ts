/** Thin fetch wrapper. Every call carries the bearer token and unwraps errors. */

const TOKEN_KEY = 'pulse.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: any,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;

  if (!res.ok) {
    if (res.status === 401) setToken(null);
    throw new ApiError(res.status, parsed?.error ?? `Request failed (${res.status}).`, parsed);
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// ------------------------------------------------------------------- types

export interface User {
  id: number;
  employeeId: string;
  name: string;
  email: string;
  role: 'ADVISOR' | 'TEAM_LEADER' | 'TRAINER' | 'OPS_MANAGER' | 'ADMIN';
  roleLabel: string;
  projectId: string | null;
  departmentCode: string;
  region: string;
  shiftRule: string;
  editWindowDays: number;
  isSupervisor: boolean;
}

export interface Group {
  key: string;
  name: string;
  type: 'SYSTEM' | 'CUSTOM' | 'ALT' | 'SELF';
  memberIds: number[];
}

export interface Person {
  id: number;
  employee_id: string;
  name: string;
  email: string;
  role: string;
  project_id: string | null;
  department_code: string;
  status: string;
  shift_rule: string;
  manager_name: string | null;
}

export interface Issue {
  level: 'error' | 'warning';
  message: string;
  rowIndex?: number;
}

export interface TimecardRow {
  id?: number;
  code: string;
  project: string;
  activity: string;
  startAt: string;
  endAt: string;
}

export interface Timecard {
  id: number;
  userId: number;
  userName: string;
  employeeId: string;
  payrollDate: string;
  shiftNo: number;
  rows: TimecardRow[];
  summary: {
    formatted: Record<string, string>;
    codes: string[];
  };
  detail: {
    startAt: string | null;
    endAt: string | null;
    startDate: string | null;
    endDate: string | null;
    crossesMidnight: boolean;
  };
  approved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  protectDate: string | null;
  manualCheckStatus: string;
  assumedOff: boolean;
  inProgress: boolean;
  edited: boolean;
  correctionReason: string | null;
  exceptions: string[];
  notes: string[];
  issues: Issue[];
}

export interface EditDecision {
  allowed: boolean;
  postPayroll: boolean;
  reason: string;
  windowStart: string;
  windowDays: number;
}

export interface ScheduleRow {
  id?: number;
  startAt: string;
  activityKey: string;
}

export interface ScheduleShift {
  shiftNo: number;
  rows: ScheduleRow[];
  endAt: string;
  /** Absent on shifts being edited client-side, which have no stored state yet. */
  status?: 'DRAFT' | 'PUBLISHED';
}

export interface Catalog {
  product: { name: string; acronym: string; short: string };
  activities: { code: string; name: string; paid: boolean; productive: boolean; family: string; defaultCode: string }[];
  codes: { code: string; name: string; paid: boolean; exception: boolean; description: string }[];
  scheduleActivities: { key: string; name: string; activity: string }[];
  shiftRules: { code: string; name: string; description: string; lunchMinutes: number; lateGraceMinutes: number }[];
  manualCheckStatuses: string[];
  editWindows: Record<string, number>;
  roleLabels: Record<string, string>;
  today: string;
}

export interface PayrollSummaryRow {
  userId: number;
  employeeId: string;
  name: string;
  payrollDate: string;
  shiftNo: number;
  codes: string[];
  regular: string;
  overtime: string;
  absence: string;
  extraHours: string;
  approved: boolean;
  assumedOff: boolean;
  inProgress: boolean;
  protectDate: string | null;
  hasErrors: boolean;
  exceptions: string[];
}

export interface ClockState {
  clockedOn: boolean;
  since: string | null;
  activity: string | null;
  activityName: string | null;
  payrollDate: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  canClockOn: boolean;
  message: string;
  mealLockUntil: string | null;
  todaySegments: { activity: string; name: string; startAt: string; endAt: string | null }[];
  availableActivities: { code: string; name: string; family: string }[];
}

export interface AdherenceResponse {
  user: User;
  date: string;
  report: {
    scheduledMinutes: number;
    actualMinutes: number;
    adherentMinutes: number;
    adherencePct: number;
    bands: { startAt: string; endAt: string; scheduled: string | null; actual: string | null; adherent: boolean }[];
    unscheduledActivities: { activity: string; name: string; formatted: string }[];
    missedActivities: { activity: string; name: string; formatted: string }[];
    scheduledTotals: { activity: string; name: string; formatted: string; minutes: number }[];
    actualTotals: { activity: string; name: string; formatted: string; minutes: number }[];
    exceptions: { code: string; name: string; formatted: string }[];
    observations: string[];
  };
  punctuality: {
    scheduledStart: string;
    scheduledEnd: string;
    actualStart: string;
    actualEnd: string;
    startVarianceMinutes: number;
    endVarianceMinutes: number;
  } | null;
  timecard: Timecard | null;
  shifts: ScheduleShift[];
}
