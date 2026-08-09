import { describe, expect, it } from 'vitest';
import { checkWorkingTime, DEFAULT_LIMITS, type RosterDay } from '../workingTime.js';
import type { ScheduleShift } from '../schedule.js';

/**
 * These cover the rules that carry a fine rather than a telling off. The one
 * that matters most is the overnight case: a shift belongs to the payroll date
 * it *started* on, so comparing dates instead of instants gets rest between
 * shifts exactly backwards.
 */

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const clock = (m: number) =>
  `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * A realistic shift: work, a half hour meal in the middle, work.
 *
 * The fixtures used to be a single unbroken block, which was fine while nothing
 * looked inside a shift — and then the five hour rule went in and every
 * eight hour fixture was correctly in breach. A shift with no break at all is
 * not a normal shift, and testing the other rules against one tests them
 * against a case that should never reach production.
 */
function shift(date: string, from: string, to: string): ScheduleShift {
  const mid = mins(from) + Math.floor((mins(to) - mins(from)) / 2);
  return {
    shiftNo: 1,
    rows: [
      { startAt: `${date} ${from}`, activityKey: 'SHIFT_START' },
      { startAt: `${date} ${clock(mid)}`, activityKey: 'LUNCH' },
      { startAt: `${date} ${clock(mid + 30)}`, activityKey: 'OPEN_TIME' },
    ],
    endAt: `${date} ${to}`,
  };
}

/** One unbroken block, for the rules that are about exactly that. */
function unbroken(date: string, from: string, to: string): ScheduleShift {
  return {
    shiftNo: 1,
    rows: [{ startAt: `${date} ${from}`, activityKey: 'SHIFT_START' }],
    endAt: `${date} ${to}`,
  };
}

function day(date: string, from?: string, to?: string): RosterDay {
  return { date, shifts: from && to ? [shift(date, from, to)] : [] };
}

/** A run of consecutive worked days from a start date. */
function run(start: string, count: number, from = '09:00', to = '17:00'): RosterDay[] {
  const out: RosterDay[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(day(d.toISOString().slice(0, 10), from, to));
  }
  return out;
}

describe('rest between shifts', () => {
  it('passes a normal day-to-day pattern', () => {
    const breaches = checkWorkingTime({
      days: [day('2026-03-02', '09:00', '17:00'), day('2026-03-03', '09:00', '17:00')],
    });
    expect(breaches).toEqual([]);
  });

  it('catches a night shift followed by a morning one', () => {
    // 23:00–07:30 then 09:00 the next day is ninety minutes off. This is the
    // case the day-at-a-time validator could never see, because each day is
    // individually perfectly legal.
    const nights: RosterDay = {
      date: '2026-03-02',
      shifts: [unbroken('2026-03-02', '23:00', '07:30')],
    };
    const breaches = checkWorkingTime({ days: [nights, day('2026-03-03', '09:00', '17:00')] });
    const rest = breaches.filter((b) => b.kind === 'rest');
    expect(rest).toHaveLength(1);
    expect(rest[0].date).toBe('2026-03-03');
    expect(rest[0].over).toBeCloseTo(9.5, 1);
  });

  it('accepts exactly the minimum', () => {
    // Finishes 22:00, starts 09:00 — eleven hours to the minute.
    const breaches = checkWorkingTime({
      days: [day('2026-03-02', '14:00', '22:00'), day('2026-03-03', '09:00', '17:00')],
    });
    expect(breaches.filter((b) => b.kind === 'rest')).toEqual([]);
  });

  it('reports overlapping shifts in plain words rather than as negative rest', () => {
    const overlapping: RosterDay = {
      date: '2026-03-02',
      shifts: [unbroken('2026-03-02', '20:00', '12:00')],
    };
    const breaches = checkWorkingTime({ days: [overlapping, day('2026-03-03', '09:00', '17:00')] });
    expect(breaches.some((b) => b.message.includes('before the previous one has finished'))).toBe(true);
  });

  it('ignores rest across a day nobody worked', () => {
    const breaches = checkWorkingTime({
      days: [day('2026-03-02', '09:00', '17:00'), day('2026-03-03'), day('2026-03-04', '09:00', '17:00')],
    });
    expect(breaches).toEqual([]);
  });
});

describe('consecutive days', () => {
  it('allows six in a row', () => {
    const breaches = checkWorkingTime({ days: run('2026-03-02', 6) });
    expect(breaches.filter((b) => b.kind === 'consecutive')).toEqual([]);
  });

  it('flags the seventh', () => {
    const breaches = checkWorkingTime({ days: run('2026-03-02', 7) });
    const consecutive = breaches.filter((b) => b.kind === 'consecutive');
    expect(consecutive).toHaveLength(1);
    expect(consecutive[0].date).toBe('2026-03-08');
    expect(consecutive[0].over).toBe(1);
  });

  it('reports a long run once, not once per day', () => {
    // Nine warnings for one nine-day run is noise, and noise is how a warning
    // gets ignored.
    const breaches = checkWorkingTime({ days: run('2026-03-02', 10, '09:00', '13:00') });
    expect(breaches.filter((b) => b.kind === 'consecutive')).toHaveLength(1);
  });

  it('starts counting again after a day off', () => {
    const days = [...run('2026-03-02', 4), day('2026-03-06'), ...run('2026-03-07', 4)];
    expect(checkWorkingTime({ days }).filter((b) => b.kind === 'consecutive')).toEqual([]);
  });

  it('does not treat a gap in the window as contiguous', () => {
    // Days handed in with 03-04 missing entirely must not be read as a run.
    const days = [day('2026-03-02', '09:00', '17:00'), day('2026-03-06', '09:00', '17:00')];
    expect(checkWorkingTime({ days }).filter((b) => b.kind === 'consecutive')).toEqual([]);
  });
});

describe('hours in a week', () => {
  it('allows a full but legal week', () => {
    // Six eight-hour days is 48 exactly.
    const breaches = checkWorkingTime({ days: run('2026-03-02', 6, '09:00', '17:00') });
    expect(breaches.filter((b) => b.kind === 'weekly')).toEqual([]);
  });

  it('flags a week over the limit', () => {
    // Six ten-hour days is 60.
    const breaches = checkWorkingTime({ days: run('2026-03-02', 6, '08:00', '18:00') });
    const weekly = breaches.filter((b) => b.kind === 'weekly');
    expect(weekly).toHaveLength(1);
    expect(weekly[0].over).toBeCloseTo(12, 1);
  });

  it('rolls, rather than resetting on a calendar boundary', () => {
    // Four ten-hour days at the end of one week and two at the start of the
    // next is 60 hours inside seven days, and a Monday-reset would miss it.
    const days = [...run('2026-03-05', 6, '08:00', '18:00')];
    expect(checkWorkingTime({ days }).filter((b) => b.kind === 'weekly')).toHaveLength(1);
  });
});

describe('what gets reported', () => {
  it('attributes breaches only to the days asked about', () => {
    // A supervisor editing Tuesday should not be shown a breach that belongs
    // entirely to the following weekend.
    const days = run('2026-03-02', 7);
    const all = checkWorkingTime({ days });
    const focused = checkWorkingTime({ days, focus: ['2026-03-02'] });
    expect(all.length).toBeGreaterThan(0);
    expect(focused).toEqual([]);
  });

  it('honours limits that are not the defaults', () => {
    const days = [day('2026-03-02', '09:00', '17:00'), day('2026-03-03', '02:00', '10:00')];
    expect(checkWorkingTime({ days }).filter((b) => b.kind === 'rest')).toHaveLength(1);
    expect(
      checkWorkingTime({
        days,
        limits: { ...DEFAULT_LIMITS, minRestHours: 8 },
      }).filter((b) => b.kind === 'rest'),
    ).toEqual([]);
  });

  it('says nothing about an empty roster', () => {
    expect(checkWorkingTime({ days: [] })).toEqual([]);
    expect(checkWorkingTime({ days: [day('2026-03-02')] })).toEqual([]);
  });
});

describe('a break after five hours', () => {
  it('accepts a shift broken by a meal', () => {
    // 09:00–17:00 with a meal in the middle is two runs of under four hours.
    const breaches = checkWorkingTime({ days: [day('2026-03-02', '09:00', '17:00')] });
    expect(breaches.filter((b) => b.kind === 'break')).toEqual([]);
  });

  it('flags a shift with no break at all', () => {
    const breaches = checkWorkingTime({
      days: [{ date: '2026-03-02', shifts: [unbroken('2026-03-02', '09:00', '17:00')] }],
    });
    const brk = breaches.filter((b) => b.kind === 'break');
    expect(brk).toHaveLength(1);
    expect(brk[0].over).toBeCloseTo(3, 1);
  });

  it('measures the longest run, not the total', () => {
    // Six hours, a break, then two. The total is legal for the day and the
    // first run is not.
    const long: ScheduleShift = {
      shiftNo: 1,
      rows: [
        { startAt: '2026-03-02 08:00', activityKey: 'SHIFT_START' },
        { startAt: '2026-03-02 14:00', activityKey: 'BREAK' },
        { startAt: '2026-03-02 14:15', activityKey: 'OPEN_TIME' },
      ],
      endAt: '2026-03-02 16:15',
    };
    const brk = checkWorkingTime({ days: [{ date: '2026-03-02', shifts: [long] }] })
      .filter((b) => b.kind === 'break');
    expect(brk).toHaveLength(1);
    expect(brk[0].over).toBeCloseTo(1, 1);
  });

  it('accepts exactly five hours', () => {
    const exact: ScheduleShift = {
      shiftNo: 1,
      rows: [
        { startAt: '2026-03-02 09:00', activityKey: 'SHIFT_START' },
        { startAt: '2026-03-02 14:00', activityKey: 'LUNCH' },
        { startAt: '2026-03-02 14:30', activityKey: 'OPEN_TIME' },
      ],
      endAt: '2026-03-02 16:30',
    };
    expect(
      checkWorkingTime({ days: [{ date: '2026-03-02', shifts: [exact] }] }).filter((b) => b.kind === 'break'),
    ).toEqual([]);
  });
});

describe('hours in a day', () => {
  it('accepts an eight hour day', () => {
    // 08:30–17:00 with a half hour meal is exactly eight worked.
    const breaches = checkWorkingTime({ days: [day('2026-03-02', '08:30', '17:00')] });
    expect(breaches.filter((b) => b.kind === 'daily' || b.kind === 'overtime')).toEqual([]);
  });

  it('flags a day past eight hours', () => {
    // 08:00–18:00 less a meal is nine and a half.
    const breaches = checkWorkingTime({ days: [day('2026-03-02', '08:00', '18:00')] });
    const daily = breaches.filter((b) => b.kind === 'daily');
    expect(daily).toHaveLength(1);
    expect(daily[0].over).toBeCloseTo(1.5, 1);
  });

  it('marks a day beyond the statutory overtime as unusual rather than refusing', () => {
    // Overtime is uncapped by policy, so this is recorded, never blocked.
    const breaches = checkWorkingTime({ days: [day('2026-03-02', '06:00', '20:00')] });
    const over = breaches.filter((b) => b.kind === 'overtime');
    expect(over).toHaveLength(1);
    expect(over[0].message).toContain('Allowed by policy');
  });

  it('counts work, not the span — a long meal is not a long day', () => {
    const split: ScheduleShift = {
      shiftNo: 1,
      rows: [
        { startAt: '2026-03-02 09:00', activityKey: 'SHIFT_START' },
        { startAt: '2026-03-02 13:00', activityKey: 'LUNCH' },
        { startAt: '2026-03-02 15:00', activityKey: 'OPEN_TIME' },
      ],
      endAt: '2026-03-02 19:00',
    };
    // Ten hours end to end, eight of them worked.
    expect(
      checkWorkingTime({ days: [{ date: '2026-03-02', shifts: [split] }] })
        .filter((b) => b.kind === 'daily' || b.kind === 'overtime'),
    ).toEqual([]);
  });
});
