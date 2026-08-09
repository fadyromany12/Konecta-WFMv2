import { describe, expect, it } from 'vitest';
import { checkWorkingTime, type RosterDay } from '../workingTime.js';
import type { ScheduleShift } from '../schedule.js';

/**
 * These cover the rules that carry a fine rather than a telling off. The one
 * that matters most is the overnight case: a shift belongs to the payroll date
 * it *started* on, so comparing dates instead of instants gets rest between
 * shifts exactly backwards.
 */

function shift(date: string, from: string, to: string): ScheduleShift {
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
      shifts: [
        {
          shiftNo: 1,
          rows: [{ startAt: '2026-03-02 23:00', activityKey: 'SHIFT_START' }],
          endAt: '2026-03-03 07:30',
        },
      ],
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
      shifts: [
        {
          shiftNo: 1,
          rows: [{ startAt: '2026-03-02 20:00', activityKey: 'SHIFT_START' }],
          endAt: '2026-03-03 12:00',
        },
      ],
    };
    const breaches = checkWorkingTime({ days: [overlapping, day('2026-03-03', '09:00', '17:00')] });
    expect(breaches[0].message).toContain('before the previous one has finished');
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
        limits: { minRestHours: 8, maxConsecutiveDays: 6, maxWeeklyHours: 48 },
      }).filter((b) => b.kind === 'rest'),
    ).toEqual([]);
  });

  it('says nothing about an empty roster', () => {
    expect(checkWorkingTime({ days: [] })).toEqual([]);
    expect(checkWorkingTime({ days: [day('2026-03-02')] })).toEqual([]);
  });
});
