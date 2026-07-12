const { startOfDay, startOfNextDay, startOfDayAfterDays } = require('../src/utils/time');
const leitner = require('../src/utils/leitner');

describe('time utils', () => {
  const tz = 'Europe/Amsterdam';

  test('startOfDay returns local midnight as UTC ISO', () => {
    // 2026-07-12T10:30Z is 12:30 local (CEST, +02:00) -> local midnight = 2026-07-11T22:00Z
    const iso = startOfDay(new Date('2026-07-12T10:30:00Z'), tz);
    expect(iso).toBe('2026-07-11T22:00:00.000Z');
  });

  test('startOfNextDay advances one local day', () => {
    const iso = startOfNextDay(new Date('2026-07-12T10:30:00Z'), tz);
    expect(iso).toBe('2026-07-12T22:00:00.000Z');
  });

  test('startOfDayAfterDays adds N days then snaps to local midnight', () => {
    const iso = startOfDayAfterDays(2, new Date('2026-07-12T10:30:00Z'), tz);
    expect(iso).toBe('2026-07-13T22:00:00.000Z');
  });

  test('handles UTC timezone', () => {
    expect(startOfDay(new Date('2026-07-12T10:30:00Z'), 'UTC')).toBe('2026-07-12T00:00:00.000Z');
  });
});

describe('leitner scheduling', () => {
  test('interval days match ported table', () => {
    expect(leitner.intervalDaysForBox(1)).toBe(0);
    expect(leitner.intervalDaysForBox(2)).toBe(2);
    expect(leitner.intervalDaysForBox(6)).toBe(32);
  });

  test('mastered stage grows by 1.5^(stage-1) from 60 days', () => {
    expect(leitner.intervalDaysForBox(7)).toBe(60); // stage 1
    expect(leitner.intervalDaysForBox(8)).toBe(90); // 60 * 1.5
  });

  test('markLearned puts word in box 1, learned, due today', () => {
    const now = new Date('2026-07-12T10:00:00Z');
    const c = leitner.markLearned(now);
    expect(c.isLearned).toBe(1);
    expect(c.leitnerBox).toBe(1);
    expect(c.nextPracticeDate).toBe(startOfDay(now));
  });

  test('correct answer advances box and schedules further out', () => {
    const now = new Date('2026-07-12T10:00:00Z');
    const c = leitner.practicedCorrectly(1, now); // -> box 2, +2 days
    expect(c.leitnerBox).toBe(2);
    expect(c.nextPracticeDate).toBe(startOfDayAfterDays(2, now));
  });

  test('incorrect answer resets to box 1, due next day', () => {
    const now = new Date('2026-07-12T10:00:00Z');
    const c = leitner.practicedIncorrectly(now);
    expect(c.leitnerBox).toBe(1);
    expect(c.nextPracticeDate).toBe(startOfNextDay(now));
  });
});
