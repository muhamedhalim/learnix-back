import {
  ELO_K_HIGH,
  ELO_K_LOW,
  ELO_K_MID,
  ELO_K_VOLUME_HIGH,
  ELO_K_VOLUME_LOW,
  SPEED_BONUS_MAX,
  SPEED_FAST_MS,
} from '../gamification.constants';

/**
 * Elo maths for solo question-solving: the question is the "opponent" and its
 * rating is derived from difficulty. All pure functions — deterministic and
 * unit-testable in isolation.
 */

/** Probability the student "beats" (correctly solves) a question of this rating. */
export function expectedScore(studentRating: number, questionRating: number): number {
  return 1 / (1 + Math.pow(10, (questionRating - studentRating) / 400));
}

/** K-factor decays with the student's solve volume in the subject. */
export function kFactor(solvedCount: number): number {
  if (solvedCount < ELO_K_VOLUME_LOW) return ELO_K_HIGH;
  if (solvedCount < ELO_K_VOLUME_HIGH) return ELO_K_MID;
  return ELO_K_LOW;
}

/**
 * Actual score in [0, 1+bonus]. Wrong = 0. Correct = 1, plus a mild speed bonus
 * for fast answers (linearly scaled up to SPEED_BONUS_MAX at instant, 0 by
 * SPEED_FAST_MS). Deliberately gentle so speed nudges, not dominates, rating.
 */
export function actualScore(isCorrect: boolean, timeMs: number): number {
  if (!isCorrect) return 0;
  if (timeMs >= SPEED_FAST_MS) return 1;
  const fastness = 1 - Math.max(0, timeMs) / SPEED_FAST_MS; // 1 = instant, 0 = at threshold
  return 1 + SPEED_BONUS_MAX * fastness;
}

/**
 * Rating change for one graded solve. Returns the delta to add to the student's
 * (subject) rating; positive on strong performance, negative on a miss.
 */
export function ratingDelta(params: {
  studentRating: number;
  questionRating: number;
  isCorrect: boolean;
  timeMs: number;
  solvedCount: number;
}): number {
  const expected = expectedScore(params.studentRating, params.questionRating);
  const actual = actualScore(params.isCorrect, params.timeMs);
  const k = kFactor(params.solvedCount);
  // Round to 2dp to match the numeric(8,2) storage and keep results stable.
  return Math.round(k * (actual - expected) * 100) / 100;
}
