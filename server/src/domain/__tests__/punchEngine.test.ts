import { describe, expect, it } from 'vitest';
import { buildTimecard, type Punch } from '../punchEngine.js';
import { SHIFT_RULE_MAP } from '../reference.js';
import type { ScheduleShift } from '../schedule.js';
import { summarize } from '../timecard.js';
import { buildAdherenceReport } from '../adherence.js';

const RULE = SHIFT_RULE_MAP.get('CR1')!;
const PROJECT = 'A123';

function shift(): ScheduleShift {
  return {
    shiftNo: 1,
    rows: [
      { startAt: '2026-03-01 23:00', activityKey: 'SHIFT_START' },
      { startAt: '2026-03-01 01:00', activityKey: 'BREAK' },
      { startAt: '2026-03-01 01:15', activityKey: 'OPEN_TIME' },
      { startAt: '2026-03-01 03:00', activityKey: 'LUNCH' },
      { startAt: '2026-03-01 03:30', activityKey: 'OPEN_TIME' },
    ],
    endAt: '2026-03-01 07:30',
  };
}

/** The scripted problem shift: late on, meal overrun, stray punch, early off. */
const MESSY: Punch[] = [
  { at: '2026-03-01 23:05', type: 'ON', activity: '01-001' },
  { at: '2026-03-02 01:00', type: 'CHANGE', activity: '26-001' },
  { at: '2026-03-02 01:15', type: 'CHANGE', activity: '01-001' },
  { at: '2026-03-02 02:30', type: 'CHANGE', activity: '15-002' },
  { at: '2026-03-02 02:57', type: 'CHANGE', activity: '01-001' },
  { at: '2026-03-02 03:00', type: 'CHANGE', activity: '99-001' },
  { at: '2026-03-02 03:40', type: 'CHANGE', activity: '16-001' },
  { at: '2026-03-02 03:42', type: 'CHANGE', activity: '01-001' },
  { at: '2026-03-02 07:22', type: 'OFF' },
];

const build = (punches: Punch[], now = '2026-03-02 09:00') =>
  buildTimecard({ shifts: [shift()], punches, rule: RULE, project: PROJECT, now });

describe('punch engine', () => {
  it('raises a Late for the gap between the scheduled start and the first punch', () => {
    const { rows } = build(MESSY);
    const late = rows.find((r) => r.code === 'LT');
    expect(late).toBeDefined();
    expect(late!.startAt).toBe('2026-03-01 23:00');
    expect(late!.endAt).toBe('2026-03-01 23:05');
  });

  it('raises a Leave Early for the gap between clocking off and the shift end', () => {
    const early = build(MESSY).rows.find((r) => r.code === 'LE');
    expect(early!.startAt).toBe('2026-03-02 07:22');
    expect(early!.endAt).toBe('2026-03-02 07:30');
  });

  it('splits a meal overrun into the allowance and a Long Lunch', () => {
    const rows = build(MESSY).rows;
    const lunch = rows.find((r) => r.code === 'LUN')!;
    const long = rows.find((r) => r.code === 'LLU')!;
    expect(lunch.endAt).toBe('2026-03-02 03:30'); // the 30 minutes allowed
    expect(long.startAt).toBe('2026-03-02 03:30');
    expect(long.endAt).toBe('2026-03-02 03:40'); // the ten minute overrun
  });

  it('produces a card with no gaps or overlaps', () => {
    const rows = build(MESSY).rows;
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].startAt).toBe(rows[i - 1].endAt);
    }
  });

  it('leaves the paid total intact when time is only recategorised', () => {
    const summary = summarize(build(MESSY).rows);
    // 23:05 to 07:22 is 08:17, less the 30 minute meal and 10 minute overrun.
    expect(summary.formatted.regular).toBe('07:37');
    expect(summary.formatted.absence).toBe('00:23');
  });

  it('assumes the scheduled end when the advisor never clocks off', () => {
    const result = build(MESSY.slice(0, -1));
    expect(result.assumedOff).toBe(true);
    expect(result.rows[result.rows.length - 1].endAt).toBe('2026-03-02 07:30');
    expect(result.notes.join(' ')).toContain('No clock off punch');
  });

  it('does not assume an end while the shift is still running', () => {
    const result = build(MESSY.slice(0, 3), '2026-03-02 02:00');
    expect(result.inProgress).toBe(true);
    expect(result.assumedOff).toBe(false);
  });

  it('raises a No Call No Show when a whole scheduled shift goes unpunched', () => {
    const result = build([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].code).toBe('NCS');
    expect(summarize(result.rows).formatted.absence).toBe('08:30');
  });

  it('does not call it a no show before the shift has even ended', () => {
    const result = build([], '2026-03-02 02:00');
    expect(result.rows).toHaveLength(0);
    expect(result.inProgress).toBe(true);
  });

  it('applies the activity default code, so a break becomes BRK not worked', () => {
    const rows = build(MESSY).rows;
    expect(rows.find((r) => r.activity === '26-001')!.code).toBe('BRK');
    expect(rows.find((r) => r.activity === '99-001')!.code).toBe('LUN');
  });
});

describe('adherence report', () => {
  it('names the activities punched but never scheduled', () => {
    const report = buildAdherenceReport({ shifts: [shift()], rows: build(MESSY).rows });
    const unscheduled = report.unscheduledActivities.map((a) => a.activity).sort();
    expect(unscheduled).toContain('15-002'); // CE training nobody scheduled
    expect(unscheduled).toContain('16-001'); // a two minute stray coaching punch
  });

  it('scores adherence against scheduled time', () => {
    const report = buildAdherenceReport({ shifts: [shift()], rows: build(MESSY).rows });
    expect(report.adherencePct).toBeGreaterThan(70);
    expect(report.adherencePct).toBeLessThan(95);
  });

  it('reports a perfect day as fully adherent', () => {
    const clean: Punch[] = [
      { at: '2026-03-01 23:00', type: 'ON', activity: '01-001' },
      { at: '2026-03-02 01:00', type: 'CHANGE', activity: '26-001' },
      { at: '2026-03-02 01:15', type: 'CHANGE', activity: '01-001' },
      { at: '2026-03-02 03:00', type: 'CHANGE', activity: '99-001' },
      { at: '2026-03-02 03:30', type: 'CHANGE', activity: '01-001' },
      { at: '2026-03-02 07:30', type: 'OFF' },
    ];
    const report = buildAdherenceReport({ shifts: [shift()], rows: build(clean).rows });
    expect(report.adherencePct).toBe(100);
    expect(report.observations).toHaveLength(0);
  });
});
