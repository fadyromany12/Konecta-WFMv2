import { describe, expect, it } from 'vitest';
import {
  EGYPT_RATES,
  costShift,
  costTimecard,
  dayCharacter,
  earnsNightAllowance,
  nightAllowance,
  nightMinutes,
  noCost,
  normHoursOn,
  totalCost,
  type PayKind,
} from '../pay.js';
import type { TimecardRow } from '../timecard.js';
import type { ScheduleShift } from '../schedule.js';

const row = (code: string, from: string, to: string, over: Partial<TimecardRow> = {}): TimecardRow => ({
  code,
  project: 'A100',
  activity: '01-001',
  startAt: `2026-05-04 ${from}`,
  endAt: to.startsWith('+') ? `2026-05-05 ${to.slice(1)}` : `2026-05-04 ${to}`,
  ...over,
});

/** An ordinary eight hour day, with the meal that makes it legal. */
const ordinaryDay = (): TimecardRow[] => [
  row('(W)', '09:00', '13:00'),
  row('LUN', '13:00', '14:00', { activity: '99-001' }),
  row('(W)', '14:00', '18:00'),
];

const paidOf = (kind: PayKind, breakdown: ReturnType<typeof costTimecard>) =>
  breakdown.lines.find((l) => l.kind === kind)?.paidMinutes ?? 0;

describe('an ordinary day', () => {
  it('pays worked time at the base rate', () => {
    const b = costTimecard({ rows: ordinaryDay(), dayCharacter: 'ORDINARY' });
    expect(b.workedMinutes).toBe(480);
    expect(b.paidMinutes).toBe(480);
    expect(b.premiumMinutes).toBe(0);
  });

  it('does not pay for the meal', () => {
    // An hour of unpaid lunch sits between two worked blocks and must not
    // reach either the worked total or the cost.
    const b = costTimecard({ rows: ordinaryDay(), dayCharacter: 'ORDINARY' });
    expect(b.workedMinutes).toBe(480);
  });

  it('pays daytime overtime at a third again', () => {
    const b = costTimecard({
      rows: [...ordinaryDay(), row('OT', '18:00', '20:00')],
      dayCharacter: 'ORDINARY',
    });
    expect(b.workedMinutes).toBe(600);
    expect(paidOf('OVERTIME_DAY', b)).toBe(120 * 1.35);
    expect(b.paidMinutes).toBe(480 + 162);
    expect(b.premiumMinutes).toBe(42);
  });

  it('pays night overtime at seven tenths again', () => {
    const b = costTimecard({
      rows: [row('(W)', '14:00', '22:00'), row('OT', '22:00', '+00:00')],
      dayCharacter: 'ORDINARY',
    });
    expect(paidOf('OVERTIME_NIGHT', b)).toBe(120 * 1.7);
    expect(paidOf('OVERTIME_DAY', b)).toBe(0);
  });

  it('splits overtime that crosses into the night', () => {
    // 20:00 to 23:00: two hours daytime, one hour night.
    const b = costTimecard({
      rows: [row('(W)', '12:00', '20:00'), row('OT', '20:00', '23:00')],
      dayCharacter: 'ORDINARY',
    });
    expect(paidOf('OVERTIME_DAY', b)).toBe(120 * 1.35);
    expect(paidOf('OVERTIME_NIGHT', b)).toBe(60 * 1.7);
  });

  it('says so when more was worked than was coded as overtime', () => {
    // Ten hours on the card with nothing coded OT. The engine costs what the
    // supervisor coded and refuses to silently reclassify it, but the
    // disagreement has to be visible.
    const b = costTimecard({
      rows: [row('(W)', '08:00', '18:00')],
      dayCharacter: 'ORDINARY',
    });
    expect(b.paidMinutes).toBe(600);
    expect(b.notes.join(' ')).toContain('coded as overtime');
  });
});

describe('a cancelled rest day', () => {
  it('pays every hour at double', () => {
    const b = costTimecard({ rows: ordinaryDay(), dayCharacter: 'REST_DAY' });
    expect(b.paidMinutes).toBe(960);
    expect(b.premiumMinutes).toBe(480);
  });

  it('does not add an overtime premium on top', () => {
    // The rule that most often differs between employers, so it is pinned:
    // double is the day's rate, not a base for overtime to multiply again.
    const b = costTimecard({
      rows: [...ordinaryDay(), row('OT', '18:00', '20:00')],
      dayCharacter: 'REST_DAY',
    });
    expect(b.paidMinutes).toBe(600 * 2);
    expect(paidOf('OVERTIME_DAY', b)).toBe(0);
    expect(b.notes.join(' ')).toContain('no separate overtime premium');
  });

  it('costs nothing when the rest day was actually taken', () => {
    expect(costTimecard({ rows: [], dayCharacter: 'REST_DAY' }).paidMinutes).toBe(0);
  });
});

describe('a public holiday', () => {
  it('pays triple when it is settled in cash', () => {
    const b = costTimecard({
      rows: ordinaryDay(),
      dayCharacter: 'PUBLIC_HOLIDAY',
      election: 'PAY_3X',
    });
    expect(b.paidMinutes).toBe(1440);
    expect(b.dayInLieuHours).toBe(0);
    expect(b.electionOutstanding).toBe(false);
  });

  it('pays double and banks a day on the other option', () => {
    const b = costTimecard({
      rows: ordinaryDay(),
      dayCharacter: 'PUBLIC_HOLIDAY',
      election: 'PAY_2X_PLUS_DAY',
    });
    expect(b.paidMinutes).toBe(960);
    expect(b.dayInLieuHours).toBe(8);
  });

  it('costs an unsettled holiday at the higher rate and says it is unsettled', () => {
    // Costing the cheaper option while nobody has chosen it would understate
    // the roster and then move the wrong way when a supervisor decides.
    const b = costTimecard({ rows: ordinaryDay(), dayCharacter: 'PUBLIC_HOLIDAY' });
    expect(b.paidMinutes).toBe(1440);
    expect(b.electionOutstanding).toBe(true);
    expect(b.notes.join(' ')).toContain('has not been settled');
  });

  it('needs no election when the holiday was not worked', () => {
    const b = costTimecard({ rows: [], dayCharacter: 'PUBLIC_HOLIDAY' });
    expect(b.electionOutstanding).toBe(false);
  });
});

describe('paid time off', () => {
  it('pays at the base rate and counts as no premium', () => {
    const b = costTimecard({
      rows: [row('PTO', '09:00', '17:00', { activity: '99-004' })],
      dayCharacter: 'ORDINARY',
    });
    expect(b.paidMinutes).toBe(480);
    expect(b.workedMinutes).toBe(0);
    expect(b.premiumMinutes).toBe(0);
  });

  it('earns no holiday premium for a day nobody worked', () => {
    // Being off on a public holiday is not working a public holiday.
    const b = costTimecard({
      rows: [row('PTO', '09:00', '17:00', { activity: '99-004' })],
      dayCharacter: 'PUBLIC_HOLIDAY',
    });
    expect(b.paidMinutes).toBe(480);
  });
});

describe('absence', () => {
  it('costs nothing', () => {
    const b = costTimecard({
      rows: [row('ABS', '09:00', '17:00', { activity: '99-003' })],
      dayCharacter: 'ORDINARY',
    });
    expect(b.paidMinutes).toBe(0);
  });
});

describe('costing a plan rather than a card', () => {
  const shift = (start: string, end: string): ScheduleShift => ({
    shiftNo: 1,
    rows: [{ startAt: `2026-05-04 ${start}`, activityKey: 'OPEN_TIME' }],
    endAt: `2026-05-04 ${end}`,
  });

  it('treats hours past the daily norm as overtime', () => {
    const b = costShift({ shift: shift('09:00', '19:00'), dayCharacter: 'ORDINARY' });
    expect(b.workedMinutes).toBe(600);
    expect(paidOf('REGULAR', b)).toBe(480);
    expect(paidOf('OVERTIME_DAY', b)).toBe(120 * 1.35);
  });

  it('reads the overtime from the end of the shift, not the start', () => {
    // 16:00 to 02:00 is ten hours; the norm is used by midnight, so the two
    // overtime hours are 00:00 to 02:00 and both fall in the night window.
    const b = costShift({
      shift: {
        shiftNo: 1,
        rows: [{ startAt: '2026-05-04 16:00', activityKey: 'OPEN_TIME' }],
        endAt: '2026-05-05 02:00',
      },
      dayCharacter: 'ORDINARY',
    });
    expect(paidOf('OVERTIME_NIGHT', b)).toBe(120 * 1.7);
    expect(paidOf('OVERTIME_DAY', b)).toBe(0);
  });

  it('does not let an unpaid meal push hours into overtime', () => {
    // 09:00 to 19:00 with an hour of lunch is nine hours worked, so one hour
    // of overtime — not two.
    const b = costShift({
      shift: {
        shiftNo: 1,
        rows: [
          { startAt: '2026-05-04 09:00', activityKey: 'OPEN_TIME' },
          { startAt: '2026-05-04 13:00', activityKey: 'LUNCH' },
          { startAt: '2026-05-04 14:00', activityKey: 'OPEN_TIME' },
        ],
        endAt: '2026-05-04 19:00',
      },
      dayCharacter: 'ORDINARY',
    });
    expect(b.workedMinutes).toBe(540);
    expect(paidOf('OVERTIME_DAY', b)).toBe(60 * 1.35);
  });

  it('costs a planned holiday at the holiday rate', () => {
    const b = costShift({ shift: shift('09:00', '17:00'), dayCharacter: 'PUBLIC_HOLIDAY' });
    expect(b.paidMinutes).toBe(480 * 3);
    expect(b.electionOutstanding).toBe(true);
  });
});

describe('the night window', () => {
  const at = (from: string, to: string) => ({ startAt: `2026-05-04 ${from}`, endAt: to });

  it('counts nothing in the middle of the day', () => {
    expect(nightMinutes(at('09:00', '2026-05-04 17:00'), '22:00', '06:00')).toBe(0);
  });

  it('counts a stretch entirely inside the window', () => {
    expect(nightMinutes(at('23:00', '2026-05-05 02:00'), '22:00', '06:00')).toBe(180);
  });

  it('counts the window that opened the previous evening', () => {
    // 02:00 to 05:00 belongs to the window that started at 22:00 yesterday, so
    // a scan that only looks at today's window finds nothing.
    expect(nightMinutes(at('02:00', '2026-05-04 05:00'), '22:00', '06:00')).toBe(180);
  });

  it('counts both ends of a shift that spans a whole day', () => {
    // 05:00 to 23:00: an hour at the start, an hour at the end.
    expect(nightMinutes(at('05:00', '2026-05-04 23:00'), '22:00', '06:00')).toBe(120);
  });

  it('handles a window that does not wrap midnight', () => {
    expect(nightMinutes(at('01:00', '2026-05-04 08:00'), '00:00', '06:00')).toBe(300);
  });

  it('reads a zero width window as no window at all', () => {
    // A typo that made every minute a night minute would be expensive and
    // entirely invisible.
    expect(nightMinutes(at('00:00', '2026-05-05 00:00'), '22:00', '22:00')).toBe(0);
  });

  it('ignores an interval that ends before it starts', () => {
    expect(nightMinutes(at('23:00', '2026-05-04 22:00'), '22:00', '06:00')).toBe(0);
  });
});

describe('adding days up', () => {
  it('totals worked, paid and premium across a week', () => {
    const week = [
      costTimecard({ rows: ordinaryDay(), dayCharacter: 'ORDINARY' }),
      costTimecard({ rows: ordinaryDay(), dayCharacter: 'ORDINARY' }),
      costTimecard({ rows: ordinaryDay(), dayCharacter: 'REST_DAY' }),
      noCost('REST_DAY'),
    ];
    const total = totalCost(week);
    expect(total.workedMinutes).toBe(1440);
    expect(total.paidMinutes).toBe(480 + 480 + 960);
    expect(total.premiumMinutes).toBe(480);
  });

  it('counts how many holidays are waiting on a decision', () => {
    const total = totalCost([
      costTimecard({ rows: ordinaryDay(), dayCharacter: 'PUBLIC_HOLIDAY' }),
      costTimecard({ rows: ordinaryDay(), dayCharacter: 'PUBLIC_HOLIDAY', election: 'PAY_3X' }),
    ]);
    expect(total.electionsOutstanding).toBe(1);
  });

  it('adds up banked days', () => {
    const total = totalCost([
      costTimecard({
        rows: ordinaryDay(),
        dayCharacter: 'PUBLIC_HOLIDAY',
        election: 'PAY_2X_PLUS_DAY',
      }),
      costTimecard({
        rows: ordinaryDay(),
        dayCharacter: 'PUBLIC_HOLIDAY',
        election: 'PAY_2X_PLUS_DAY',
      }),
    ]);
    expect(total.dayInLieuHours).toBe(16);
  });
});

describe('what kind of day it was', () => {
  const holidays = new Set(['2026-05-01']);

  it('calls an unrostered day a rest day', () => {
    expect(dayCharacter({ date: '2026-05-04', holidays, scheduled: false })).toBe('REST_DAY');
  });

  it('calls a rostered day ordinary', () => {
    expect(dayCharacter({ date: '2026-05-04', holidays, scheduled: true })).toBe('ORDINARY');
  });

  it('lets a public holiday beat a rest day', () => {
    // A holiday landing on somebody's day off, then worked, is still a holiday
    // — and pays triple rather than double.
    expect(dayCharacter({ date: '2026-05-01', holidays, scheduled: false })).toBe('PUBLIC_HOLIDAY');
  });
});

describe('the rates themselves', () => {
  it('carries the Egyptian statutory overtime rates', () => {
    expect(EGYPT_RATES.overtimeDay).toBe(1.35);
    expect(EGYPT_RATES.overtimeNight).toBe(1.7);
    expect(EGYPT_RATES.nightFrom).toBe('22:00');
    expect(EGYPT_RATES.nightTo).toBe('06:00');
  });

  it('can be overridden without touching the engine', () => {
    const b = costTimecard({
      rows: [...ordinaryDay(), row('OT', '18:00', '20:00')],
      dayCharacter: 'ORDINARY',
      rates: { ...EGYPT_RATES, overtimeDay: 1.5 },
    });
    expect(paidOf('OVERTIME_DAY', b)).toBe(180);
  });
});

describe('the night allowance', () => {
  const shiftEnding = (start: string, end: string): ScheduleShift => ({
    shiftNo: 1,
    rows: [{ startAt: `2026-05-04 ${start}`, activityKey: 'OPEN_TIME' }],
    endAt: end.startsWith('+') ? `2026-05-05 ${end.slice(1)}` : `2026-05-04 ${end}`,
  });

  it('is earned by a shift that finishes after nine', () => {
    expect(earnsNightAllowance(shiftEnding('13:00', '21:30'))).toBe(true);
  });

  it('is earned exactly at nine', () => {
    expect(earnsNightAllowance(shiftEnding('13:00', '21:00'))).toBe(true);
  });

  it('is not earned by a day shift', () => {
    expect(earnsNightAllowance(shiftEnding('09:00', '17:30'))).toBe(false);
  });

  it('is earned by a shift running past midnight', () => {
    // Its finishing clock time is 07:30, which is early rather than late. Read
    // naively that is a day shift, and it is the most obviously night shift
    // there is.
    expect(earnsNightAllowance(shiftEnding('23:00', '+07:30'))).toBe(true);
  });

  it('is earned before the statutory night window is even touched', () => {
    // 21:30 earns the allowance and contains no 22:00-06:00 hours at all. The
    // two rules answer different questions, which is the whole point.
    const shift = shiftEnding('13:00', '21:45');
    expect(earnsNightAllowance(shift)).toBe(true);
    expect(costShift({ shift, dayCharacter: 'ORDINARY' }).lines.some((l) => l.kind === 'OVERTIME_NIGHT')).toBe(false);
  });
});

describe('how much of the night allowance was earned', () => {
  const nights = (scheduled: number, worked: number) =>
    Array.from({ length: scheduled }, (_, i) => ({ scheduled: true, worked: i < worked }));

  it('reports the fraction the allowance is discussed in', () => {
    const a = nightAllowance(nights(22, 20));
    expect(a.fraction).toBe('20/22');
    expect(a.percent).toBe(90.9);
  });

  it('is whole when every rostered night was worked', () => {
    expect(nightAllowance(nights(22, 22)).proportion).toBe(1);
  });

  it('counts a rostered night lost to absence as not worked', () => {
    const a = nightAllowance([...nights(21, 21), { scheduled: true, worked: false }]);
    expect(a.fraction).toBe('21/22');
  });

  it('ignores days that were never rostered as nights', () => {
    // Working a night nobody asked for does not inflate the denominator.
    const a = nightAllowance([...nights(22, 22), { scheduled: false, worked: true }]);
    expect(a.fraction).toBe('22/22');
  });

  it('does not divide by zero for somebody who works no nights', () => {
    const a = nightAllowance([{ scheduled: false, worked: false }]);
    expect(a.proportion).toBe(0);
    expect(a.fraction).toBe('0/0');
  });
});

describe('the Ramadan working day', () => {
  const ramadan = new Set(['2026-02-18']);

  it('is six hours inside Ramadan', () => {
    expect(normHoursOn('2026-02-18', ramadan)).toBe(6);
  });

  it('is eight outside it', () => {
    expect(normHoursOn('2026-05-04', ramadan)).toBe(8);
  });

  it('starts overtime two hours earlier', () => {
    const shift: ScheduleShift = {
      shiftNo: 1,
      rows: [{ startAt: '2026-02-18 09:00', activityKey: 'OPEN_TIME' }],
      endAt: '2026-02-18 17:00',
    };
    const normal = costShift({ shift, dayCharacter: 'ORDINARY' });
    const fasting = costShift({
      shift,
      dayCharacter: 'ORDINARY',
      rates: { ...EGYPT_RATES, dailyNormHours: normHoursOn('2026-02-18', ramadan) },
    });
    expect(paidOf('OVERTIME_DAY', normal)).toBe(0);
    expect(paidOf('OVERTIME_DAY', fasting)).toBe(120 * 1.35);
  });
});
