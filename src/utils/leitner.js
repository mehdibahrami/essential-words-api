const { startOfDay, startOfNextDay, startOfDayAfterDays } = require('./time');

// Box -> interval in days. Ported from DatabaseManager.leitnerIntervals.
const LEITNER_INTERVAL_DAYS = { 1: 0, 2: 2, 3: 4, 4: 8, 5: 16, 6: 32 };
const NUM_LEITNER_BOXES = Object.keys(LEITNER_INTERVAL_DAYS).length; // 6
const MASTERED_REVIEW_DAYS = 60;

/** Days until next review after advancing *into* `box`. Mirrors wordPracticedCorrectly. */
function intervalDaysForBox(box) {
  if (LEITNER_INTERVAL_DAYS[box] !== undefined) return LEITNER_INTERVAL_DAYS[box];
  const masteredStage = box - NUM_LEITNER_BOXES; // stage 1 = first box past 6
  return MASTERED_REVIEW_DAYS * Math.pow(1.5, Math.max(0, masteredStage - 1));
}

/** Field changes for finishing initial review (markWordAsInitiallyLearned). */
function markLearned(now = new Date()) {
  return {
    isLearned: 1,
    leitnerBox: 1,
    lastReviewedDate: now.toISOString(),
    nextPracticeDate: startOfDay(now),
  };
}

/** Field changes for a correct practice answer (swipe right). */
function practicedCorrectly(currentBox, now = new Date()) {
  const nextBox = currentBox + 1;
  return {
    leitnerBox: nextBox,
    lastReviewedDate: now.toISOString(),
    nextPracticeDate: startOfDayAfterDays(intervalDaysForBox(nextBox), now),
  };
}

/** Field changes for an incorrect practice answer (swipe left). */
function practicedIncorrectly(now = new Date()) {
  return {
    leitnerBox: 1,
    lastReviewedDate: now.toISOString(),
    nextPracticeDate: startOfNextDay(now),
  };
}

module.exports = {
  LEITNER_INTERVAL_DAYS,
  NUM_LEITNER_BOXES,
  MASTERED_REVIEW_DAYS,
  intervalDaysForBox,
  markLearned,
  practicedCorrectly,
  practicedIncorrectly,
};
