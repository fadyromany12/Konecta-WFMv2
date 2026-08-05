import { describe, expect, it } from 'vitest';
import {
  addShift,
  clockOnWindow,
  deleteRow,
  insertRowAbove,
  resolveRowDates,
  scheduledPaidMinutes,
  shiftSpan,
  toSegments,
  validateSchedule,
  type ScheduleShift,
} from '../schedule.js';
import { SHIFT_RULE_MAP } from '../reference.js';

/** 23:00–07:30 overnight shift with a break, a meal and a second break. */
function overnight(): ScheduleShift {
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

describe('row date resolution', () => {
  it('rolls rows past midnight onto the following day', () => {
    // Every row is entered against the shift's date; the system decides the day.
    const resolved = resolveRowDates(overnight());
    expect(resolved.rows.map((r) => r.startAt)).toEqual([
      '2026-03-01 23:00',
      '2026-03-02 01:00',
      '2026-03-02 01:15',
      '2026-03-02 03:00',
      '2026-03-02 03:30',
    ]);
    expect(resolved.endAt).toBe('2026-03-02 07:30');
  });

  it('derives each row end from the next row start', () => {
    const segments = toSegments(overnight());
    expect(segments[1].activityName).toBe('Break');
    expect(segments[1].minutes).toBe(15);
    expect(segments[3].activityName).toBe('Lunch');
    expect(segments[3].minutes).toBe(30);
    expect(segments[segments.length - 1].endAt).toBe('2026-03-02 07:30');
  });

  it('measures the whole shift across midnight', () => {
    expect(shiftSpan(overnight()).minutes).toBe(510);
  });
});

describe('editing gestures', () => {
  it('inserts a row above the selected one', () => {
    // Adding training that ran 02:30–03:00 needs one row above the meal.
    const edited = insertRowAbove(overnight(), 3, 'TRAINING', '02:30');
    expect(edited.rows[3].activityKey).toBe('TRAINING');
    expect(edited.rows[3].startAt).toBe('2026-03-02 02:30');
    expect(edited.rows[4].activityKey).toBe('LUNCH');
  });

  it('deletes a cancelled event and lets the surrounding time close up', () => {
    const edited = deleteRow(overnight(), 1);
    expect(edited.rows).toHaveLength(4);
    const segments = toSegments(edited);
    expect(segments[0].endAt).toBe(segments[1].startAt);
  });

  it('adds a second shift for extra hours after the first one ends', () => {
    const shifts = addShift([overnight()], '2026-03-01', '08:00', '12:00', 'EXTRA_HOURS');
    expect(shifts).toHaveLength(2);
    expect(shifts[1].shiftNo).toBe(2);
    expect(shiftSpan(shifts[1]).minutes).toBe(240);
  });
});

describe('schedule validation', () => {
  it('accepts a valid overnight shift entered on its start date', () => {
    expect(validateSchedule([overnight()], '2026-03-01').filter((i) => i.level === 'error')).toHaveLength(0);
  });

  it('refuses a shift entered against the wrong date', () => {
    // Getting this wrong breaks the start-of-day process and the advisor
    // cannot clock on at all.
    const errors = validateSchedule([overnight()], '2026-03-02').filter((i) => i.level === 'error');
    expect(errors[0].message).toContain('entered on the date it starts');
  });

  it('refuses two shifts that overlap each other', () => {
    const second: ScheduleShift = {
      shiftNo: 2,
      rows: [{ startAt: '2026-03-02 07:00', activityKey: 'EXTRA_HOURS' }],
      endAt: '2026-03-02 11:00',
    };
    const errors = validateSchedule([overnight(), second], '2026-03-01').filter((i) => i.level === 'error');
    expect(errors.some((e) => e.message.includes('before shift 1 ends'))).toBe(true);
  });

  it('flags a row with no duration', () => {
    const broken: ScheduleShift = {
      shiftNo: 1,
      rows: [
        { startAt: '2026-03-01 23:00', activityKey: 'SHIFT_START' },
        { startAt: '2026-03-01 23:00', activityKey: 'BREAK' },
      ],
      endAt: '2026-03-02 07:30',
    };
    const errors = validateSchedule([broken], '2026-03-01').filter((i) => i.level === 'error');
    expect(errors.some((e) => e.message.includes('no duration'))).toBe(true);
  });
});

describe('derived figures', () => {
  it('excludes the unpaid meal from scheduled paid minutes', () => {
    expect(scheduledPaidMinutes([overnight()])).toBe(510 - 30);
  });

  it('opens the clock window ahead of the shift by the rule lead time', () => {
    const window = clockOnWindow([overnight()], SHIFT_RULE_MAP.get('CR1')!.clockOnLeadMinutes);
    expect(window?.earliest).toBe('2026-03-01 22:45');
  });
});
