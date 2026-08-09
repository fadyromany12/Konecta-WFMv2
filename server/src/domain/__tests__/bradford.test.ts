import { describe, expect, it } from 'vitest';
import {
  bandFor,
  bradford,
  daysSinceLast,
  describe as describePattern,
  toSpells,
  windowStart,
} from '../bradford.js';

const abs = (date: string, code = 'ABS') => ({ date, code });

describe('the weighting that makes Bradford worth using', () => {
  it('scores ten scattered single days far above one long illness', () => {
    const scattered = bradford({
      absences: [
        '2026-01-05', '2026-02-03', '2026-03-10', '2026-04-07', '2026-05-12',
        '2026-06-02', '2026-07-14', '2026-08-04', '2026-09-08', '2026-10-06',
      ].map((d) => abs(d)),
    });
    const oneIllness = bradford({
      absences: ['2026-03-02','2026-03-03','2026-03-04','2026-03-05','2026-03-06',
                 '2026-03-07','2026-03-08','2026-03-09','2026-03-10','2026-03-11'].map((d) => abs(d)),
    });

    expect(scattered.days).toBe(10);
    expect(oneIllness.days).toBe(10);
    expect(scattered.score).toBe(1000); // 10² × 10
    expect(oneIllness.score).toBe(10); // 1² × 10
    expect(scattered.score).toBeGreaterThan(oneIllness.score * 50);
  });

  it('is spells squared times days', () => {
    const out = bradford({ absences: [abs('2026-03-02'), abs('2026-05-05'), abs('2026-07-07')] });
    expect(out.spells).toBe(3);
    expect(out.days).toBe(3);
    expect(out.score).toBe(27);
  });
});

describe('what counts as one occasion', () => {
  it('joins consecutive days into a single spell', () => {
    const spells = toSpells([abs('2026-03-02'), abs('2026-03-03'), abs('2026-03-04')]);
    expect(spells).toHaveLength(1);
    expect(spells[0]).toMatchObject({ start: '2026-03-02', end: '2026-03-04', days: 3 });
  });

  it('does not split a spell across a rest day when the roster is consulted', () => {
    // Friday and Monday, with the weekend not worked. One absence, not two.
    const workingDayBefore = (date: string) => (date === '2026-03-09' ? '2026-03-06' : null);
    const spells = toSpells([abs('2026-03-06'), abs('2026-03-09')], workingDayBefore);
    expect(spells).toHaveLength(1);
    expect(spells[0].days).toBe(2);
  });

  it('and would wrongly split it without that knowledge, which is why the hook exists', () => {
    expect(toSpells([abs('2026-03-06'), abs('2026-03-09')])).toHaveLength(2);
  });

  it('quadruples the score if a weekend splits a spell, which is the unfairness being avoided', () => {
    const joined = bradford({
      absences: [abs('2026-03-06'), abs('2026-03-09')],
      workingDayBefore: (d) => (d === '2026-03-09' ? '2026-03-06' : null),
    });
    const split = bradford({ absences: [abs('2026-03-06'), abs('2026-03-09')] });
    expect(joined.score).toBe(2); // 1² × 2
    expect(split.score).toBe(8); // 2² × 2
  });

  it('treats two codes on one date as one absent day', () => {
    const out = bradford({ absences: [abs('2026-03-02', 'ABS'), abs('2026-03-02', 'SCK')] });
    expect(out.days).toBe(1);
    expect(out.spells).toBe(1);
    expect(out.spellDetail[0].codes).toEqual(['ABS', 'SCK']);
  });

  it('sorts before grouping, so the order rows arrive in does not matter', () => {
    const forwards = toSpells([abs('2026-03-02'), abs('2026-03-03')]);
    const backwards = toSpells([abs('2026-03-03'), abs('2026-03-02')]);
    expect(backwards).toEqual(forwards);
  });
});

describe('what is counted at all', () => {
  it('counts unplanned absence, sickness, no-shows and authorised absence', () => {
    for (const code of ['ABS', 'NCS', 'SCK', 'MAA']) {
      expect(bradford({ absences: [abs('2026-03-02', code)] }).days).toBe(1);
    }
  });

  it('ignores booked leave entirely', () => {
    const out = bradford({
      absences: [abs('2026-03-02', 'PTO'), abs('2026-03-03', 'UTO'), abs('2026-06-01', 'ABS')],
    });
    expect(out.days).toBe(1);
    expect(out.spells).toBe(1);
    expect(out.score).toBe(1);
  });

  it('does not let a fortnight of booked holiday register at all', () => {
    const holiday = Array.from({ length: 14 }, (_, i) =>
      abs(`2026-07-${String(i + 1).padStart(2, '0')}`, 'PTO'),
    );
    expect(bradford({ absences: holiday }).score).toBe(0);
  });
});

describe('trigger bands', () => {
  it('leaves an ordinary record alone', () => {
    expect(bandFor(0)).toBe('NONE');
    expect(bandFor(50)).toBe('NONE');
  });

  it('escalates at the published thresholds', () => {
    expect(bandFor(51)).toBe('REVIEW');
    expect(bandFor(200)).toBe('REVIEW');
    expect(bandFor(201)).toBe('CONCERN');
    expect(bandFor(400)).toBe('CONCERN');
    expect(bandFor(401)).toBe('FORMAL');
  });

  it('does not trigger on a single long illness however long it runs', () => {
    const month = Array.from({ length: 30 }, (_, i) =>
      abs(`2026-04-${String(i + 1).padStart(2, '0')}`, 'SCK'),
    );
    const out = bradford({ absences: month });
    expect(out.days).toBe(30);
    expect(out.score).toBe(30);
    expect(out.band).toBe('NONE');
  });

  it('does trigger on three separate single days', () => {
    const out = bradford({ absences: [abs('2026-01-05'), abs('2026-04-06'), abs('2026-08-03')] });
    expect(out.score).toBe(27);
    expect(out.band).toBe('NONE');
    // A fourth crosses it.
    const four = bradford({
      absences: [abs('2026-01-05'), abs('2026-04-06'), abs('2026-08-03'), abs('2026-10-05')],
    });
    expect(four.score).toBe(64);
    expect(four.band).toBe('REVIEW');
  });
});

describe('saying it in words a team leader can use', () => {
  it('says nothing happened when nothing did', () => {
    expect(describePattern(bradford({ absences: [] }))).toContain('No unplanned absence');
  });

  it('names a single absence as planned around once', () => {
    const out = describePattern(bradford({ absences: [abs('2026-03-02'), abs('2026-03-03')] }));
    expect(out).toContain('One absence of 2 days');
  });

  it('calls out the all-single-days pattern specifically', () => {
    const out = describePattern(
      bradford({ absences: [abs('2026-01-05'), abs('2026-04-06'), abs('2026-08-03')] }),
    );
    expect(out).toContain('3 separate occasions');
    expect(out).toContain('single day');
  });

  it('reports the longest spell when they are not all single days', () => {
    const out = describePattern(
      bradford({ absences: [abs('2026-01-05'), abs('2026-04-06'), abs('2026-04-07')] }),
    );
    expect(out).toContain('longest 2 days');
  });
});

describe('the window', () => {
  it('is the 52 weeks ending today, not the calendar year', () => {
    // Inclusive of today, so 363 days back plus today is exactly 364 days.
    expect(windowStart('2026-08-09')).toBe('2025-08-11');
  });

  it('says how long since the last occasion', () => {
    const out = bradford({ absences: [abs('2026-08-01')] });
    expect(daysSinceLast(out, '2026-08-09')).toBe(8);
    expect(daysSinceLast(bradford({ absences: [] }), '2026-08-09')).toBeNull();
  });
});
