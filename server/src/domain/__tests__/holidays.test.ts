import { describe, expect, it } from 'vitest';
import { holidaysFor, holidayRange, ramadanDates } from '../holidays.js';

const on = (year: number, date: string) => holidaysFor(year).filter((h) => h.date === date);
const named = (year: number, fragment: string) =>
  holidaysFor(year).filter((h) => h.name.includes(fragment));

describe('the dates that never move', () => {
  it('places the national days', () => {
    expect(on(2026, '2026-01-25')[0]?.name).toContain('Revolution Day');
    expect(on(2026, '2026-04-25')[0]?.name).toBe('Sinai Liberation Day');
    expect(on(2026, '2026-05-01')[0]?.name).toBe('Labour Day');
    expect(on(2026, '2026-10-06')[0]?.name).toBe('Armed Forces Day');
  });

  it('does not mark them estimated', () => {
    for (const holiday of holidaysFor(2026).filter((h) => h.basis !== 'ISLAMIC')) {
      expect(holiday.estimated).toBe(false);
    }
  });

  it('gives the same answer for every year', () => {
    for (const year of [2025, 2026, 2027, 2030]) {
      expect(on(year, `${year}-07-23`)).toHaveLength(1);
    }
  });
});

describe('Sham El-Nessim', () => {
  // The Monday after Orthodox Easter. Orthodox Easter falls on 12 April 2026
  // and 2 May 2027, which are the published dates.
  it('follows Orthodox Easter', () => {
    expect(named(2026, 'Sham El-Nessim')[0]?.date).toBe('2026-04-13');
    expect(named(2027, 'Sham El-Nessim')[0]?.date).toBe('2027-05-03');
  });

  it('is always a Monday', () => {
    for (let year = 2025; year <= 2035; year++) {
      const date = named(year, 'Sham El-Nessim')[0]!.date;
      expect(new Date(`${date}T00:00:00Z`).getUTCDay()).toBe(1);
    }
  });
});

describe('the Islamic dates', () => {
  it('places Eid al-Fitr where the arithmetic calendar puts it', () => {
    expect(named(2026, 'Eid al-Fitr')[0]?.date).toBe('2026-03-20');
  });

  it('runs Eid al-Fitr for three days', () => {
    expect(named(2026, 'Eid al-Fitr')).toHaveLength(3);
  });

  it('marks every one of them estimated', () => {
    // The whole point: Egypt settles these by sighting, so the calendar is a
    // starting position and never an authority.
    for (const holiday of holidaysFor(2026).filter((h) => h.basis === 'ISLAMIC')) {
      expect(holiday.estimated).toBe(true);
    }
  });

  it('finds a holiday that falls twice in one Gregorian year', () => {
    // The Hijri year is eleven days shorter, so a holiday early in January can
    // come round again in December. Converting a year would miss the second.
    expect(named(2008, 'Islamic New Year').map((h) => h.date)).toEqual([
      '2008-01-10',
      '2008-12-29',
    ]);
  });
});

describe('the calendar as a whole', () => {
  it('never lists a date twice', () => {
    const dates = holidayRange(2025, 2035).map((h) => h.date);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('keeps every date inside its own year', () => {
    for (const holiday of holidaysFor(2026)) expect(holiday.date.slice(0, 4)).toBe('2026');
  });

  it('keeps both names when two holidays land on one day', () => {
    // Sham El-Nessim falls on Sinai Liberation Day in 2033. It is one day off,
    // and it is still both holidays.
    const shared = holidaysFor(2033).find((h) => h.date === '2033-04-25')!;
    expect(shared.name).toContain('Sinai Liberation Day');
    expect(shared.name).toContain('Sham El-Nessim');
  });

  it('treats a shared day as certain when anything certain is on it', () => {
    for (const holiday of holidayRange(2020, 2060)) {
      if (!holiday.estimated) continue;
      // An estimated date must be purely Islamic; anything else on it fixes it.
      expect(holiday.basis).toBe('ISLAMIC');
      expect(FIXED_DATES.has(holiday.date.slice(5))).toBe(false);
    }
  });

  it('returns them in order', () => {
    const dates = holidaysFor(2026).map((h) => h.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

const FIXED_DATES = new Set(['01-07', '01-25', '04-25', '05-01', '06-30', '07-23', '10-06']);

describe('Ramadan', () => {
  // Egypt shortens the working day for the month, so these dates decide when
  // overtime starts — not just what the calendar says.
  it('finds Ramadan in 2026', () => {
    const days = [...ramadanDates(2026)].sort();
    expect(days.length).toBeGreaterThan(25);
    // 1 Ramadan 1447 falls on 18 February 2026 by the arithmetic calendar.
    expect(days[0]).toBe('2026-02-18');
  });

  it('runs twenty-nine or thirty days', () => {
    for (const year of [2025, 2026, 2027]) {
      const days = [...ramadanDates(year)].filter((d) => d.startsWith(String(year)));
      // A year can clip a Ramadan at either end, so only assert on a full one.
      if (days.length > 25) expect(days.length).toBeLessThanOrEqual(30);
    }
  });

  it('ends the day before Eid al-Fitr', () => {
    // Eid is 1 Shawwal, the day after Ramadan ends. If these disagree the two
    // conversions are not talking about the same calendar.
    const lastFast = [...ramadanDates(2026)].sort().pop()!;
    const eid = holidaysFor(2026).find((h) => h.name.startsWith('Eid al-Fitr'))!;
    expect(new Date(`${eid.date}T00:00:00Z`).getTime() - new Date(`${lastFast}T00:00:00Z`).getTime()).toBe(
      86400000,
    );
  });

  it('does not claim Ramadan is a public holiday', () => {
    // It is a shorter working day, not a day off, and confusing the two would
    // pay a month of triple time.
    const inRamadan = [...ramadanDates(2026)];
    const holidays = new Set(holidaysFor(2026).map((h) => h.date));
    expect(inRamadan.filter((d) => holidays.has(d))).toHaveLength(0);
  });
});
