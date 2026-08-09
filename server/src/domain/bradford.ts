/**
 * Absence patterns, not just absence.
 *
 * The Bradford Factor is S² × D over a rolling window — spells squared, times
 * total days. It is the BPO standard because it weights *frequency* over
 * duration, and frequency is what actually breaks a roster: ten separate
 * one-day absences score 1000, one ten-day illness scores 10. The first means
 * ten mornings where somebody rebuilt the day at 08:55 with a queue already
 * building; the second was known about by Tuesday and planned around.
 *
 * That weighting is a judgement about disruption, and it is worth being honest
 * that it is only that. A high score is a reason to have a conversation, not a
 * finding about the person: the commonest causes of a scattered pattern are
 * chronic conditions, caring responsibilities and disability, none of which are
 * conduct. So this module returns the arithmetic and a trigger band, and it
 * deliberately does not return a recommendation.
 *
 * Two rules do the real work and both exist to keep the score fair:
 *
 * Consecutive absent days are **one spell**, and a weekend or a rest day in the
 * middle does not split it. Someone absent Friday and Monday was absent once,
 * and counting it twice quadruples their score for having been ill across a
 * weekend.
 *
 * Planned absence is **not counted at all**. Approved holiday is not
 * disruption; it is the roster working as intended. Counting booked leave would
 * make the score a measure of taking your entitlement.
 */

import { addDays, diffDays, type DateStr } from './time.js';

/**
 * Absence codes that count toward the score, and what each one is.
 *
 * `MAA` — management approved absence — is deliberately included: it is
 * unplanned, it was authorised after the fact, and it costs the roster the same
 * as any other unplanned gap. `PTO` and `UTO` are deliberately excluded because
 * they were booked in advance.
 */
export const COUNTED_CODES = ['ABS', 'NCS', 'SCK', 'MAA'] as const;
export type CountedCode = (typeof COUNTED_CODES)[number];

export const PLANNED_CODES = ['PTO', 'UTO'] as const;

export interface AbsenceDay {
  date: DateStr;
  code: string;
}

export interface Spell {
  start: DateStr;
  end: DateStr;
  days: number;
  codes: string[];
}

export interface BradfordResult {
  /** Distinct occasions. This is the term squared. */
  spells: number;
  /** Total days absent across those spells. */
  days: number;
  score: number;
  band: TriggerBand;
  spellDetail: Spell[];
  /** Days excluded because they were booked in advance. */
  plannedDays: number;
}

export type TriggerBand = 'NONE' | 'REVIEW' | 'CONCERN' | 'FORMAL';

/**
 * The bands most UK and European BPO policies settle on, over 52 weeks.
 *
 * They are configurable in real deployments and these are the defaults, not a
 * law. 51 is the first score reachable without either a long illness or a
 * genuinely scattered pattern: it takes three separate spells.
 */
export const TRIGGERS: { band: TriggerBand; from: number; label: string }[] = [
  { band: 'NONE', from: 0, label: 'Nothing to look at' },
  { band: 'REVIEW', from: 51, label: 'Worth a conversation' },
  { band: 'CONCERN', from: 201, label: 'Review with the advisor' },
  { band: 'FORMAL', from: 401, label: 'Formal attendance process' },
];

export function bandFor(score: number): TriggerBand {
  let band: TriggerBand = 'NONE';
  for (const trigger of TRIGGERS) if (score >= trigger.from) band = trigger.band;
  return band;
}

export function labelFor(band: TriggerBand): string {
  return TRIGGERS.find((t) => t.band === band)?.label ?? band;
}

/**
 * Group absent days into spells.
 *
 * `workingDayBefore` decides whether two absences are consecutive. Passing a
 * predicate rather than a set of dates keeps this pure while letting the caller
 * answer from the roster: a Friday and a Monday absence with a rostered rest
 * day between them is one spell, and without that knowledge it would be two.
 */
export function toSpells(
  absences: readonly AbsenceDay[],
  workingDayBefore: (date: DateStr) => DateStr | null = defaultPreviousDay,
): Spell[] {
  const sorted = [...absences].sort((a, b) => a.date.localeCompare(b.date));
  const spells: Spell[] = [];

  for (const absence of sorted) {
    const current = spells[spells.length - 1];
    // Same day twice — two codes on one date, which happens when a shift is
    // split — is one absent day, not two.
    if (current && current.end === absence.date) {
      if (!current.codes.includes(absence.code)) current.codes.push(absence.code);
      continue;
    }

    const previousWorking = workingDayBefore(absence.date);
    if (current && previousWorking !== null && current.end === previousWorking) {
      current.end = absence.date;
      current.days += 1;
      if (!current.codes.includes(absence.code)) current.codes.push(absence.code);
      continue;
    }

    spells.push({ start: absence.date, end: absence.date, days: 1, codes: [absence.code] });
  }

  return spells;
}

/** Calendar-adjacent only, for callers with no roster to consult. */
function defaultPreviousDay(date: DateStr): DateStr {
  return addDays(date, -1);
}

export function bradford(params: {
  absences: readonly AbsenceDay[];
  plannedDays?: number;
  workingDayBefore?: (date: DateStr) => DateStr | null;
}): BradfordResult {
  const counted = params.absences.filter((a) =>
    (COUNTED_CODES as readonly string[]).includes(a.code),
  );
  const spellDetail = toSpells(counted, params.workingDayBefore);
  const spells = spellDetail.length;
  const days = spellDetail.reduce((sum, s) => sum + s.days, 0);
  const score = spells * spells * days;

  return {
    spells,
    days,
    score,
    band: bandFor(score),
    spellDetail,
    plannedDays: params.plannedDays ?? 0,
  };
}

/**
 * The standard window: the 52 weeks ending today.
 *
 * Rolling rather than a fixed year, because a fixed year means every score
 * resets on 1 January and somebody with a January pattern is invisible until
 * March.
 */
export function windowStart(today: DateStr, weeks = 52): DateStr {
  return addDays(today, -(weeks * 7 - 1));
}

/**
 * A plain reading, in the words a team leader would use.
 *
 * States the pattern rather than the score, because "S² × D = 384" is not
 * something anybody can act on and "six separate occasions, mostly single
 * days" is.
 */
export function describe(result: BradfordResult): string {
  if (result.spells === 0) return 'No unplanned absence in the period.';

  const occasions = `${result.spells} ${result.spells === 1 ? 'occasion' : 'separate occasions'}`;
  const total = `${result.days} ${result.days === 1 ? 'day' : 'days'}`;

  if (result.spells === 1) {
    return `One absence of ${total}. Planned around once rather than repeatedly.`;
  }

  const longest = Math.max(...result.spellDetail.map((s) => s.days));
  const shape =
    longest === 1
      ? 'every one of them a single day, which is the pattern that costs a roster most'
      : `the longest ${longest} days`;

  return `${occasions} totalling ${total} — ${shape}.`;
}

/** Days between the last absence and today, for spotting a settled pattern. */
export function daysSinceLast(result: BradfordResult, today: DateStr): number | null {
  if (result.spellDetail.length === 0) return null;
  const last = result.spellDetail[result.spellDetail.length - 1].end;
  return diffDays(last, today);
}
