import type { Role } from './guide';

/**
 * The guided tour.
 *
 * Distinct from the guide drawer, which is reference you go to when stuck. This
 * is the thing that runs once, points at the real controls, and gets somebody
 * from "signed in" to "knows where their job lives".
 *
 * Two decisions worth stating.
 *
 * **It is per role.** A tour that shows an advisor the payroll summary is worse
 * than no tour: it teaches them the tool is not for them. Each role gets the
 * three or four screens they will actually open.
 *
 * **It is versioned.** A tutorial written once and never revisited is a
 * tutorial that quietly goes stale as the product changes. Bumping `VERSION`
 * re-offers the tour to people who completed an earlier one, and the drawer
 * tells them what changed rather than silently starting again — so updating
 * this file is a normal thing to do rather than a decision about whether to
 * interrupt everybody.
 */

/**
 * Bump when the steps change materially. Anyone who finished an older version
 * is offered the new one; anyone mid-tour is restarted rather than resumed into
 * steps that may no longer line up.
 */
export const TUTORIAL_VERSION = 4;

/** Shown when a returning user is re-offered the tour. Keep it to one line. */
export const WHATS_NEW =
  'Updated for Team Week, live updates, the ⌘K palette and bulk approval.';

export interface TourStep {
  /**
   * CSS selector for the element to point at. The first match wins. A step
   * whose target is missing is skipped rather than shown floating, so a tour
   * written for a supervisor degrades quietly on an advisor's screen.
   */
  target?: string;
  /** Route to be on before this step makes sense. */
  route?: string;
  title: string;
  body: string;
  /** Which side of the target to place the bubble. */
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

const CLOCK: TourStep[] = [
  {
    route: '/dashboard',
    target: '.clock',
    placement: 'right',
    title: 'This is your clock',
    body: 'Clock on when your shift starts, change activity whenever what you are doing changes, and clock off at the end. It only opens inside your scheduled window.',
  },
  {
    route: '/dashboard',
    target: '.clock-actions select',
    placement: 'bottom',
    title: 'Pick what you are doing',
    body: 'Break, lunch, training, phones. Changing activity is almost always what you want — clocking off ends your shift.',
  },
];

const SELF_SERVICE: TourStep[] = [
  {
    route: '/my',
    target: '.subtabs',
    placement: 'bottom',
    title: 'Everything you can arrange yourself',
    body: 'Time off checked against what you have accrued, shift swaps with a colleague, and bidding for extra hours.',
  },
];

const REPORT: TourStep[] = [
  {
    route: '/reports',
    target: '.bands',
    placement: 'bottom',
    title: 'Your day, back to you',
    body: 'Green is time spent doing what was planned. “Worth asking about” is a prompt for a conversation, not an accusation.',
  },
];

const LIVE_BOARD: TourStep[] = [
  {
    route: '/dashboard',
    target: '.kpis',
    placement: 'bottom',
    title: 'Where the team is, right now',
    body: 'These move as things happen rather than on a timer. This is the only screen in the tool that looks forwards.',
  },
  {
    route: '/dashboard',
    target: '.board',
    placement: 'top',
    title: 'The live board',
    body: 'One cell per advisor on shift, coloured by what they are doing. A no-show is filled rather than outlined — that is a cover problem, not a chase.',
  },
];

const PULSE_LINE: TourStep[] = [
  {
    target: '.pulseline',
    placement: 'bottom',
    title: 'The pulse is real',
    body: 'It beats when a live update actually arrives and flattens when the connection drops. If it is flat, screens are refreshing on a timer instead.',
  },
];

const PALETTE: TourStep[] = [
  {
    target: '.cmdk',
    placement: 'bottom',
    title: 'Search anything',
    body: 'Press ⌘K — Ctrl-K off a Mac. Type a screen, or an advisor’s name to land straight on their report or schedule.',
  },
];

const BELL: TourStep[] = [
  {
    target: '.bell-wrap',
    placement: 'bottom',
    title: 'What happened while you were away',
    body: 'Late starts, swaps waiting on you, schedules somebody changed. The dot underneath is lit while updates are arriving live.',
  },
];

const APPROVALS: TourStep[] = [
  {
    route: '/time',
    target: 'table',
    placement: 'top',
    title: 'Clear yesterday here',
    body: 'One row per timecard, with its codes and the approval checkbox. Anything odd is meant to be visible without opening the card.',
  },
  {
    route: '/time',
    target: '[data-tour="bulk-approve"]',
    placement: 'bottom',
    title: 'Approve the boring ones at once',
    body: 'This only touches cards with no exceptions, no errors, a real clock-off and a finished day. Everything else is deliberately left for you to read.',
  },
];

const TEAM_WEEK: TourStep[] = [
  {
    route: '/scheduling/week',
    target: '.team-week',
    placement: 'top',
    title: 'The whole team, the whole week',
    body: 'Headcount sits under each date, so a thin Friday shows itself. Drag a shift to move the day; click it to open that day in the editor.',
  },
];

const PLANNING: TourStep[] = [
  {
    route: '/scheduling/forecast',
    target: '.chart',
    placement: 'top',
    title: 'Cover against requirement',
    body: 'Bars are who you have rostered; the line is what the forecast asks for. The gap is the entire point of the chart.',
  },
];

const ANALYTICS: TourStep[] = [
  {
    route: '/reports/analytics',
    target: '.chart',
    placement: 'bottom',
    title: 'The pattern, not the incident',
    body: 'One exception is a conversation. A column of them is a different conversation, and only this view tells the two apart.',
  },
];

const GUIDE: TourStep[] = [
  {
    target: '.help-btn',
    placement: 'left',
    title: 'The guide knows where you are',
    body: 'Press ? on any screen. It opens on the screen you are looking at, with a section written for your role.',
  },
];

/**
 * Ordered per role. Deliberately short — four or five steps that a person will
 * finish, rather than a complete tour they will skip at step two.
 */
export const TOURS: Record<Role, TourStep[]> = {
  ADVISOR: [...CLOCK, ...SELF_SERVICE, ...REPORT, ...BELL, ...GUIDE],
  TEAM_LEADER: [...LIVE_BOARD, ...PULSE_LINE, ...TEAM_WEEK, ...APPROVALS, ...BELL, ...PALETTE, ...GUIDE],
  TRAINER: [...LIVE_BOARD, ...APPROVALS, ...REPORT, ...PALETTE, ...GUIDE],
  OPS_MANAGER: [...LIVE_BOARD, ...TEAM_WEEK, ...PLANNING, ...ANALYTICS, ...APPROVALS, ...PALETTE, ...GUIDE],
  ADMIN: [...LIVE_BOARD, ...PALETTE, ...ANALYTICS, ...BELL, ...GUIDE],
};

export function tourFor(role: string): TourStep[] {
  return TOURS[role as Role] ?? TOURS.ADVISOR;
}

// ------------------------------------------------------------------ progress

const KEY = 'pulse.tutorial';

interface Progress {
  version: number;
  /** Index reached. Equal to the step count once finished. */
  step: number;
  done: boolean;
}

export function readProgress(): Progress | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Progress;
    return typeof parsed?.version === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeProgress(step: number, done: boolean): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: TUTORIAL_VERSION, step, done }));
  } catch {
    /* A private window with no storage should still be able to take the tour. */
  }
}

/**
 * Whether to offer the tour, and how to phrase the offer.
 *
 * `updated` is the case worth getting right: somebody who already took an older
 * tour should be told what changed rather than being handed the same
 * introduction again as though they were new.
 */
export function tutorialOffer(): { show: boolean; updated: boolean; resumeAt: number } {
  const progress = readProgress();
  if (!progress) return { show: true, updated: false, resumeAt: 0 };
  if (progress.version !== TUTORIAL_VERSION) return { show: true, updated: true, resumeAt: 0 };
  if (!progress.done) return { show: true, updated: false, resumeAt: progress.step };
  return { show: false, updated: false, resumeAt: 0 };
}
