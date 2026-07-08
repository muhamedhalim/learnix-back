import { Difficulty } from '../exams/entities/difficulty.enum';

/**
 * Central tuning constants for the gamification engine. Kept in one file so the
 * XP / rating / streak / rank economy is auditable at a glance. In a later
 * milestone these become admin-editable rows; for M1 they are code constants.
 */

/** Fixed app timezone for daily/streak/challenge windows (Egyptian LMS). */
export const APP_TIMEZONE = 'Africa/Cairo';

/**
 * Minimum think-time (ms) below which a solve earns NO XP/rating and is flagged
 * as suspicious. Blunts rapid-fire bots / click-through farming.
 */
export const MIN_SOLVE_TIME_MS = 1500;

/** Base XP for the FIRST correct solve of a question, by difficulty. */
export const XP_BASE_BY_DIFFICULTY: Record<Difficulty, number> = {
  [Difficulty.EASY]: 10,
  [Difficulty.MEDIUM]: 20,
  [Difficulty.HARD]: 35,
  [Difficulty.EXPERT]: 55,
};

/** Default difficulty used when a question has none set. */
export const DEFAULT_DIFFICULTY = Difficulty.MEDIUM;

/**
 * Combo milestones (consecutive correct answers in one session) → flat bonus XP
 * awarded once when the milestone is reached.
 */
export const COMBO_BONUSES: ReadonlyArray<{ at: number; xp: number }> = [
  { at: 5, xp: 15 },
  { at: 10, xp: 40 },
  { at: 20, xp: 100 },
];

/** Bonus XP for extending a daily streak (first qualifying solve of a new day). */
export const STREAK_DAILY_BONUS = 25;

/** Streak-length milestones → extra one-time bonus XP. */
export const STREAK_MILESTONES: ReadonlyArray<{ days: number; xp: number }> = [
  { days: 7, xp: 100 },
  { days: 30, xp: 500 },
  { days: 100, xp: 2000 },
];

/** One-off XP bonuses awarded by cross-flow hooks (guarded, additive). */
export const XP_PERFECT_EXAM = 150;
export const XP_LESSON_COMPLETION = 30;
export const XP_COURSE_COMPLETION = 300;

/* ------------------------------- Rating (Elo) ------------------------------ */

/** Seed rating each question carries, derived from its difficulty. */
export const QUESTION_RATING_BY_DIFFICULTY: Record<Difficulty, number> = {
  [Difficulty.EASY]: 1000,
  [Difficulty.MEDIUM]: 1300,
  [Difficulty.HARD]: 1600,
  [Difficulty.EXPERT]: 1900,
};

/** Rating every new student/subject starts at. */
export const STARTING_RATING = 1200;

/**
 * K-factor decays as a student solves more questions in a subject, so early
 * results move the rating fast and it stabilises with volume.
 */
export const ELO_K_HIGH = 40; // < K_VOLUME_LOW solves
export const ELO_K_MID = 24; // < K_VOLUME_HIGH solves
export const ELO_K_LOW = 16; // otherwise
export const ELO_K_VOLUME_LOW = 20;
export const ELO_K_VOLUME_HIGH = 60;

/**
 * Speed bonus: a fast correct answer nudges `actual` above 1.0 (capped), a slow
 * one leaves it at 1.0. Wrong answers are always 0. Tunable, deliberately mild.
 */
export const SPEED_FAST_MS = 8000;
export const SPEED_BONUS_MAX = 0.15;

/* --------------------------------- Levels ---------------------------------- */

/**
 * Level curve: cumulative XP needed rises quadratically. `level(xp)` and
 * `xpForLevel(n)` are inverse; both live in `leveling.ts`.
 */
export const LEVEL_BASE_XP = 100;
export const LEVEL_GROWTH = 1.5;

/* ------------------------------- Rank tiers -------------------------------- */

/** Seed ladder (also written by the migration/seeder). Editable in admin (M3). */
export const RANK_TIER_SEEDS: ReadonlyArray<{
  slug: string;
  name: string;
  icon_key: string;
  color: string;
  min_rating: number;
  min_xp: number;
  order: number;
}> = [
  { slug: 'bronze', name: 'Bronze', icon_key: 'bronze', color: '#CD7F32', min_rating: 0, min_xp: 0, order: 1 },
  { slug: 'silver', name: 'Silver', icon_key: 'silver', color: '#C0C0C0', min_rating: 1200, min_xp: 500, order: 2 },
  { slug: 'gold', name: 'Gold', icon_key: 'gold', color: '#FFD700', min_rating: 1450, min_xp: 2000, order: 3 },
  { slug: 'diamond', name: 'Diamond', icon_key: 'diamond', color: '#4FC3F7', min_rating: 1700, min_xp: 6000, order: 4 },
  { slug: 'legend', name: 'Legend', icon_key: 'legend', color: '#B388FF', min_rating: 1950, min_xp: 15000, order: 5 },
];

/* ----------------------------- Redis / boards ------------------------------ */

/** Redis sorted-set keys for the hot leaderboards. */
export const LB_KEYS = {
  globalRating: 'lb:global:rating',
  globalXp: 'lb:global:xp',
  subjectRating: (subjectId: string): string => `lb:subject:${subjectId}:rating`,
  weeklyXp: (isoWeek: string): string => `lb:weekly:xp:${isoWeek}`,
} as const;
