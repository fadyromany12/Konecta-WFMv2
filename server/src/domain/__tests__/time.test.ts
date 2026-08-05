import { describe, expect, it } from 'vitest';
import {
  addDays,
  diffDays,
  diffMinutes,
  formatDuration,
  isTime,
  resolveAfter,
  toMinutes,
} from '../time.js';

describe('time primitives', () => {
  it('requires a leading zero on a 24 hour clock', () => {
    expect(isTime('05:00')).toBe(true);
    expect(isTime('5:00')).toBe(false);
    expect(isTime('24:00')).toBe(false);
    expect(isTime('23:59')).toBe(true);
  });

  it('rolls the date forward when a time goes backwards', () => {
    // 02:30 typed into a shift that started at 23:00 belongs to the next day.
    expect(resolveAfter('2026-03-01 23:00', '02:30')).toBe('2026-03-02 02:30');
    expect(resolveAfter('2026-03-01 23:00', '23:30')).toBe('2026-03-01 23:30');
  });

  it('treats an identical time as the same day, not a full day later', () => {
    expect(resolveAfter('2026-03-01 07:30', '07:30')).toBe('2026-03-01 07:30');
  });

  it('measures durations across midnight', () => {
    expect(diffMinutes('2026-03-01 23:05', '2026-03-02 07:22')).toBe(497);
    expect(formatDuration(497)).toBe('08:17');
  });

  it('formats negative durations', () => {
    expect(formatDuration(-75)).toBe('-01:15');
  });

  it('counts days across a month boundary', () => {
    expect(diffDays('2026-02-26', '2026-03-01')).toBe(3);
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
  });

  it('orders stamps consistently with their minute values', () => {
    expect(toMinutes('2026-03-02 00:10')).toBeGreaterThan(toMinutes('2026-03-01 23:50'));
  });
});
