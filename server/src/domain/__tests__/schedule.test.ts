import { describe, expect, it } from 'vitest';
import {
  activeShift,
  addShift,
  clockOnWindow,
  deleteRow,
  insertRowAbove,
  resolveRowDates,
  shiftByDays,
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

describe('which shift a moment belongs to', () => {
  // The live board reads two days at once, so "when were they due on?" has to
  // be answered per shift rather than across the whole window.
  const day = (date: string, start: string, end: string): ScheduleShift => ({
    shiftNo: 1,
    rows: [{ startAt: `${date} ${start}`, activityKey: 'SHIFT_START' }],
    endAt: `${end.length > 5 ? end : `${date} ${end}`}`,
  });

  it('picks the shift containing the moment', () => {
    const shifts = [day('2025-06-10', '09:00', '17:00'), day('2025-06-11', '09:00', '17:00')];
    const active = activeShift(shifts, '2025-06-11 10:30', '2025-06-11');
    expect(active?.rows[0].startAt).toBe('2025-06-11 09:00');
  });

  it('never measures against a shift that already ended', () => {
    // The bug this exists to prevent: yesterday's shift being treated as the
    // one today's advisor is late for, which read as 1833 minutes late.
    const shifts = [day('2025-06-10', '09:00', '17:00'), day('2025-06-11', '09:00', '17:00')];
    const active = activeShift(shifts, '2025-06-11 09:20', '2025-06-11');
    expect(active?.rows[0].startAt).toBe('2025-06-11 09:00');
    expect(active?.rows[0].startAt).not.toBe('2025-06-10 09:00');
  });

  it('falls forward to the next shift due today when between shifts', () => {
    const shifts = [day('2025-06-11', '14:00', '22:00')];
    const active = activeShift(shifts, '2025-06-11 08:00', '2025-06-11');
    expect(active?.rows[0].startAt).toBe('2025-06-11 14:00');
  });

  it('returns nothing once every shift has finished', () => {
    const shifts = [day('2025-06-10', '09:00', '17:00')];
    expect(activeShift(shifts, '2025-06-11 08:00', '2025-06-11')).toBeNull();
  });

  it('keeps an overnight shift current after midnight', () => {
    const overnight: ScheduleShift = {
      shiftNo: 1,
      rows: [{ startAt: '2025-06-10 23:00', activityKey: 'SHIFT_START' }],
      endAt: '2025-06-11 07:30',
    };
    const active = activeShift([overnight], '2025-06-11 02:00', '2025-06-11');
    expect(active?.rows[0].startAt).toBe('2025-06-10 23:00');
  });

  it('prefers the containing shift over a later one on the same day', () => {
    const shifts = [day('2025-06-11', '06:00', '14:00'), day('2025-06-11', '18:00', '22:00')];
    const active = activeShift(shifts, '2025-06-11 09:00', '2025-06-11');
    expect(active?.rows[0].startAt).toBe('2025-06-11 06:00');
  });
});

describe('moving a shift to another day', () => {
  it('moves every stamp by the same number of days', () => {
    const moved = shiftByDays(overnight(), 1);
    expect(moved.rows[0].startAt).toBe('2026-03-02 23:00');
    expect(moved.endAt).toBe('2026-03-02 07:30');
  });

  it('keeps an overnight shift overnight', () => {
    // The trap: re-deriving dates from times would be right for a day shift
    // and would collapse this one onto a single date.
    const resolved = resolveRowDates(overnight());
    const moved = shiftByDays(resolved, 3);
    expect(moved.rows[0].startAt).toBe('2026-03-04 23:00');
    // Rows after midnight keep their own, later, date.
    expect(moved.rows[1].startAt).toBe('2026-03-05 01:00');
    expect(shiftSpan(moved).minutes).toBe(shiftSpan(resolved).minutes);
  });

  it('moves backwards as readily as forwards', () => {
    const moved = shiftByDays(overnight(), -1);
    expect(moved.rows[0].startAt).toBe('2026-02-28 23:00');
  });

  it('crosses a month end without losing a day', () => {
    const shift: ScheduleShift = {
      shiftNo: 1,
      rows: [{ startAt: '2026-01-31 09:00', activityKey: 'SHIFT_START' }],
      endAt: '2026-01-31 17:00',
    };
    expect(shiftByDays(shift, 1).rows[0].startAt).toBe('2026-02-01 09:00');
  });

  it('never changes the clock times', () => {
    const moved = shiftByDays(overnight(), 14);
    expect(moved.rows.map((r) => r.startAt.slice(11))).toEqual(
      overnight().rows.map((r) => r.startAt.slice(11)),
    );
  });

  it('is a no-op at zero', () => {
    expect(shiftByDays(overnight(), 0)).toEqual(overnight());
  });
});
