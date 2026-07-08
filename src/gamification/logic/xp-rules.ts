import { Difficulty } from '../../exams/entities/difficulty.enum';
import {
  COMBO_BONUSES,
  DEFAULT_DIFFICULTY,
  STREAK_MILESTONES,
  XP_BASE_BY_DIFFICULTY,
} from '../gamification.constants';

/** Base XP for the first correct solve of a question of this difficulty. */
export function baseXpForDifficulty(difficulty: Difficulty | null): number {
  return XP_BASE_BY_DIFFICULTY[difficulty ?? DEFAULT_DIFFICULTY];
}

/**
 * Bonus XP when a combo count lands exactly on a milestone (5/10/20…). Returns 0
 * otherwise, so the bonus is awarded once per milestone crossing.
 */
export function comboBonusFor(newCombo: number): number {
  const hit = COMBO_BONUSES.find((c) => c.at === newCombo);
  return hit ? hit.xp : 0;
}

/** Bonus XP when a streak length lands exactly on a milestone (7/30/100…). */
export function streakMilestoneBonusFor(newStreak: number): number {
  const hit = STREAK_MILESTONES.find((m) => m.days === newStreak);
  return hit ? hit.xp : 0;
}
