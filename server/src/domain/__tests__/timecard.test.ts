import { describe, expect, it } from 'vitest';
import {
  exceptionCodes,
  mergeContiguous,
  payrollShiftDetail,
  summarize,
  validateTimecard,
  type TimecardRow,
} from '../timecard.js';

const P = 'A123';
const row = (code: string, activity: string, start: string, end: string): TimecardRow => ({
  code,
  project: P,
  activity,
  startAt: start,
  endAt: end,
});

/** An overnight shift: on at 23:05 (5 late), meal 03:00, off at 07:22 (8 early). */
const OVERNIGHT: TimecardRow[] = [
  row('LT', '99-003', '2026-03-01 23:00', '2026-03-01 23:05'),
  row('(W)', '01-001', '2026-03-01 23:05', '2026-03-02 03:00'),
  row('LUN', '99-001', '2026-03-02 03:00', '2026-03-02 03:30'),
  row('(W)', '01-001', '2026-03-02 03:30', '2026-03-02 07:22'),
  row('LE', '99-003', '2026-03-02 07:22', '2026-03-02 07:30'),
];

describe('timecard validation', () => {
  it('accepts a well formed overnight card', () => {
    expect(validateTimecard(OVERNIGHT, '2026-03-01').filter((i) => i.level === 'error')).toHaveLength(0);
  });

  it('catches a gap left by deleting a row without accounting for the time', () => {
    const rows = [
      row('(W)', '01-001', '2026-03-01 23:05', '2026-03-02 03:40'),
      row('(W)', '01-001', '2026-03-02 03:42', '2026-03-02 07:22'),
    ];
    const errors = validateTimecard(rows, '2026-03-01').filter((i) => i.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Gap of 00:02');
  });

  it('catches overlapping rows', () => {
    const rows = [
      row('(W)', '01-001', '2026-03-01 23:05', '2026-03-02 06:25'),
      row('(W)', '16-001', '2026-03-02 06:00', '2026-03-02 06:25'),
    ];
    const errors = validateTimecard(rows, '2026-03-01').filter((i) => i.level === 'error');
    expect(errors.some((e) => e.message.includes('Overlap'))).toBe(true);
  });

  it('catches an end time before its own start — the cause of a shifted card', () => {
    const rows = [row('(W)', '01-001', '2026-03-02 06:00', '2026-03-02 05:00')];
    const errors = validateTimecard(rows, '2026-03-02').filter((i) => i.level === 'error');
    expect(errors[0].message).toContain('time-shifted');
  });

  it('refuses a card whose paid time starts on a different date to its payroll date', () => {
    const errors = validateTimecard(OVERNIGHT, '2026-03-02').filter((i) => i.level === 'error');
    expect(errors.some((e) => e.message.includes('single payroll date'))).toBe(true);
  });
});

describe('payroll shift detail', () => {
  it('spans the first to the last paid row, ignoring absence at the edges', () => {
    const detail = payrollShiftDetail(OVERNIGHT);
    expect(detail.startAt).toBe('2026-03-01 23:05');
    expect(detail.endAt).toBe('2026-03-02 07:22');
    expect(detail.startDate).toBe('2026-03-01');
    expect(detail.endDate).toBe('2026-03-02');
    expect(detail.crossesMidnight).toBe(true);
  });

  it('reports nothing when no paid time exists', () => {
    const detail = payrollShiftDetail([row('NCS', '99-003', '2026-03-01 23:00', '2026-03-02 07:30')]);
    expect(detail.startAt).toBeNull();
  });
});

describe('summary buckets', () => {
  const summary = summarize(OVERNIGHT);

  it('pays worked time and excludes the unpaid meal', () => {
    expect(summary.formatted.regular).toBe('07:47');
    expect(summary.formatted.unpaidMeal).toBe('00:30');
  });

  it('rolls late and leave early into absence', () => {
    expect(summary.formatted.absence).toBe('00:13');
  });

  it('lists the codes on the card for the summary screen', () => {
    expect(summary.codes).toEqual(['(W)', 'LE', 'LT', 'LUN']);
  });

  it('counts extra hours as regular, never as overtime', () => {
    const withExtra = summarize([row('EXH', '07-001', '2026-03-02 07:30', '2026-03-02 11:30')]);
    expect(withExtra.formatted.regular).toBe('04:00');
    expect(withExtra.formatted.overtime).toBe('00:00');
    expect(withExtra.formatted.extraHours).toBe('04:00');
  });

  it('does not pay a worked code sitting on an unpaid activity', () => {
    // The pairing trap: the code says worked, the activity says unpaid meal.
    const bad = summarize([row('(W)', '99-001', '2026-03-02 03:30', '2026-03-02 03:40')]);
    expect(bad.formatted.regular).toBe('00:00');
  });

  it('surfaces only the codes worth investigating', () => {
    expect(exceptionCodes(OVERNIGHT)).toEqual(['LE', 'LT']);
  });
});

describe('contiguous row merging', () => {
  it('merges adjacent rows sharing code, project and activity', () => {
    // Correcting a Long Lunch back to phone time makes the row vanish into its
    // neighbours — expected behaviour, and surprising if you have not seen it.
    const merged = mergeContiguous([
      row('(W)', '01-001', '2026-03-02 03:30', '2026-03-02 03:40'),
      row('(W)', '01-001', '2026-03-02 03:40', '2026-03-02 05:00'),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].startAt).toBe('2026-03-02 03:30');
    expect(merged[0].endAt).toBe('2026-03-02 05:00');
  });

  it('keeps rows apart when the activity differs', () => {
    const merged = mergeContiguous([
      row('(W)', '01-001', '2026-03-02 03:30', '2026-03-02 03:40'),
      row('(W)', '16-001', '2026-03-02 03:40', '2026-03-02 05:00'),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('does not merge across a gap', () => {
    const merged = mergeContiguous([
      row('(W)', '01-001', '2026-03-02 03:30', '2026-03-02 03:40'),
      row('(W)', '01-001', '2026-03-02 03:42', '2026-03-02 05:00'),
    ]);
    expect(merged).toHaveLength(2);
  });
});
