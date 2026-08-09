import { describe, expect, it } from 'vitest';
import {
  CAIRO,
  egyptUtcOffset,
  iftarWarning,
  prayerCoverage,
  prayerTimes,
  PRAYER_GRACE_MINUTES,
} from '../prayer.js';

const timeOf = (date: string, name: string) =>
  prayerTimes(date, CAIRO).times.find((t) => t.name === name)!.at;

const mins = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

describe('prayer times for Cairo', () => {
  it('produces all six', () => {
    expect(prayerTimes('2026-06-21', CAIRO).times).toHaveLength(6);
  });

  it('puts them in the order of the day', () => {
    const times = prayerTimes('2026-06-21', CAIRO).times.map((t) => mins(t.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  /*
   * Against published Cairo tables. A couple of minutes either way is expected
   * from a low-precision solar position; twenty would mean the convention is
   * wrong, which is the mistake worth catching.
   */
  it('matches the published midsummer sunset to within a few minutes', () => {
    // Cairo sunset on the June solstice is about 19:57 local, which is UTC+3
    // because Egypt is on summer time in June.
    expect(Math.abs(mins(timeOf('2026-06-21', 'MAGHRIB')) - mins('19:57'))).toBeLessThanOrEqual(4);
  });

  it('matches the published midwinter sunset too', () => {
    // About 16:58 on the December solstice, on standard time.
    expect(Math.abs(mins(timeOf('2026-12-21', 'MAGHRIB')) - mins('16:58'))).toBeLessThanOrEqual(4);
  });

  it('puts solar noon near the middle of the day all year', () => {
    // Under summer time the clock reads an hour later for the same solar
    // event, so midsummer noon is about 13:00 and not about 12:00. That is the
    // correct answer, and asserting a single band year-round would be
    // asserting that Egypt does not observe summer time.
    for (const [date, expected] of [
      ['2026-03-20', 12],
      ['2026-06-21', 13],
      ['2026-09-22', 13],
      ['2026-12-21', 12],
    ] as const) {
      const dhuhr = mins(timeOf(date, 'DHUHR'));
      expect(Math.abs(dhuhr - expected * 60)).toBeLessThan(30);
    }
  });

  it('shifts the whole day by an hour when summer time starts', () => {
    // Last Friday of April 2026 is the 24th.
    const before = mins(timeOf('2026-04-23', 'MAGHRIB'));
    const after = mins(timeOf('2026-04-25', 'MAGHRIB'));
    expect(after - before).toBeGreaterThan(55);
    expect(after - before).toBeLessThan(65);
  });

  it('and back again when it ends', () => {
    // Last Thursday of October 2026 is the 29th.
    expect(mins(timeOf('2026-10-28', 'MAGHRIB')) - mins(timeOf('2026-10-30', 'MAGHRIB')))
      .toBeGreaterThan(55);
  });

  it('knows Egypt was on standard time all year before 2023', () => {
    expect(egyptUtcOffset('2020-07-01')).toBe(2);
  });

  it('moves sunset by well over an hour between the solstices', () => {
    const summer = mins(timeOf('2026-06-21', 'MAGHRIB'));
    const winter = mins(timeOf('2026-12-21', 'MAGHRIB'));
    expect(summer - winter).toBeGreaterThan(150);
  });

  it('keeps sunrise before Dhuhr and Maghrib after Asr', () => {
    const t = prayerTimes('2026-08-09', CAIRO);
    const get = (n: string) => mins(t.times.find((x) => x.name === n)!.at);
    expect(get('SUNRISE')).toBeLessThan(get('DHUHR'));
    expect(get('ASR')).toBeLessThan(get('MAGHRIB'));
    expect(get('MAGHRIB')).toBeLessThan(get('ISHA'));
  });

  it('does not wander at the turn of the year', () => {
    // The equation of time is computed from two longitudes that can be a whole
    // turn apart around 1 January; unwrapped, noon lands in the small hours.
    for (const date of ['2025-12-31', '2026-01-01', '2026-01-02']) {
      const dhuhr = mins(timeOf(date, 'DHUHR'));
      expect(dhuhr).toBeGreaterThan(mins('11:30'));
      expect(dhuhr).toBeLessThan(mins('12:30'));
    }
  });

  it('answers for a different site', () => {
    // Further west means a later clock time for the same solar event.
    const alexandria = { latitude: 31.2001, longitude: 29.9187, utcOffset: 3 };
    expect(mins(prayerTimes('2026-06-21', alexandria).times.find((t) => t.name === 'MAGHRIB')!.at))
      .toBeGreaterThan(mins(timeOf('2026-06-21', 'MAGHRIB')));
  });
});

describe('whether a shift makes room for prayer', () => {
  const date = '2026-06-21'; // Maghrib about 19:57

  it('reports a prayer inside the shift as covered when a break sits on it', () => {
    const out = prayerCoverage({
      date,
      shiftStart: '14:00',
      shiftEnd: '22:00',
      breaks: [{ startTime: '19:50', minutes: 30 }],
    });
    const maghrib = out.find((c) => c.prayer === 'MAGHRIB')!;
    expect(maghrib.covered).toBe(true);
  });

  it('counts a break that starts before the prayer and runs through it', () => {
    const out = prayerCoverage({
      date,
      shiftStart: '14:00',
      shiftEnd: '22:00',
      breaks: [{ startTime: '19:40', minutes: 30 }], // runs to 20:10, over 19:57
    });
    expect(out.find((c) => c.prayer === 'MAGHRIB')!.nearestBreakMinutes).toBe(0);
  });

  it('reports it uncovered when the nearest break is an hour away', () => {
    const out = prayerCoverage({
      date,
      shiftStart: '14:00',
      shiftEnd: '22:00',
      breaks: [{ startTime: '17:00', minutes: 30 }],
    });
    const maghrib = out.find((c) => c.prayer === 'MAGHRIB')!;
    expect(maghrib.covered).toBe(false);
    expect(maghrib.nearestBreakMinutes).toBeGreaterThan(PRAYER_GRACE_MINUTES);
  });

  it('ignores prayers that fall outside the shift entirely', () => {
    const out = prayerCoverage({
      date,
      shiftStart: '09:00',
      shiftEnd: '15:00',
      breaks: [{ startTime: '12:30', minutes: 30 }],
    });
    expect(out.some((c) => c.prayer === 'MAGHRIB')).toBe(false);
    expect(out.some((c) => c.prayer === 'DHUHR')).toBe(true);
  });

  it('handles an overnight shift rather than finding nothing in it', () => {
    // 23:00 to 07:30 contains Fajr, which is asked for explicitly here.
    const out = prayerCoverage({
      date,
      shiftStart: '23:00',
      shiftEnd: '07:30',
      breaks: [{ startTime: '03:00', minutes: 30 }],
      prayers: ['FAJR'],
    });
    expect(out).toHaveLength(1);
    expect(out[0].prayer).toBe('FAJR');
  });

  it('says a shift with no breaks at all has none nearby', () => {
    const out = prayerCoverage({ date, shiftStart: '14:00', shiftEnd: '22:00', breaks: [] });
    expect(out.every((c) => c.covered === false && c.nearestBreakMinutes === null)).toBe(true);
  });
});

describe('the warning that carries the most weight', () => {
  const date = '2026-06-21';
  const uncovered = prayerCoverage({
    date,
    shiftStart: '14:00',
    shiftEnd: '22:00',
    breaks: [{ startTime: '16:00', minutes: 30 }],
  });

  it('says nothing when the break is where it should be', () => {
    const covered = prayerCoverage({
      date,
      shiftStart: '14:00',
      shiftEnd: '22:00',
      breaks: [{ startTime: '19:50', minutes: 30 }],
    });
    expect(iftarWarning(covered, true)).toBeNull();
    expect(iftarWarning(covered, false)).toBeNull();
  });

  it('notes an uncovered Maghrib outside Ramadan', () => {
    const out = iftarWarning(uncovered, false)!;
    expect(out).toContain('Maghrib');
    expect(out).not.toContain('Ramadan');
  });

  it('says what is actually at stake during Ramadan', () => {
    const out = iftarWarning(uncovered, true)!;
    expect(out).toContain('Iftar');
    expect(out).toContain('not have eaten since dawn'.slice(4));
  });

  it('says so plainly when there is no break at all', () => {
    const none = prayerCoverage({ date, shiftStart: '14:00', shiftEnd: '22:00', breaks: [] });
    expect(iftarWarning(none, true)).toContain('not scheduled at all');
  });

  it('says nothing when Maghrib is not in the shift', () => {
    const morning = prayerCoverage({ date, shiftStart: '06:00', shiftEnd: '14:00', breaks: [] });
    expect(iftarWarning(morning, true)).toBeNull();
  });
});
