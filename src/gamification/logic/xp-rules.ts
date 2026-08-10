import { Difficulty } from '../../exams/entities/difficulty.enum';
import {
  COMBO_BONUSES,
  DEFAULT_DIFFICULTY,
  STREAK_MILESTONES,
  XP_BASE_BY_DIFFICULTY,
} from '../gamification.constants';

export interface ComboBonusRule {
  at: number;
  xp: number;
}

export interface StreakMilestoneRule {
  days: number;
  xp: number;
}

/**
 * Base XP for the first correct solve of a question of this difficulty.
 * `table` defaults to the platform's hardcoded constants — DEF-018 lets
 * `GamificationRulesService` pass the currently active admin-configured
 * ruleset instead, without changing this function's default behavior for
 * every other caller (including the existing unit tests below).
 */
export function baseXpForDifficulty(
  difficulty: Difficulty | null,
  table: Record<Difficulty, number> = XP_BASE_BY_DIFFICULTY,
): number {
  return table[difficulty ?? DEFAULT_DIFFICULTY];
}

/**
 * Bonus XP when a combo count lands exactly on a milestone (5/10/20…). Returns 0
 * otherwise, so the bonus is awarded once per milestone crossing.
 */
export function comboBonusFor(
  newCombo: number,
  rules: readonly ComboBonusRule[] = COMBO_BONUSES,
): number {
  const hit = rules.find((c) => c.at === newCombo);
  return hit ? hit.xp : 0;
}

/** Bonus XP when a streak length lands exactly on a milestone (7/30/100…). */
export function streakMilestoneBonusFor(
  newStreak: number,
  rules: readonly StreakMilestoneRule[] = STREAK_MILESTONES,
): number {
  const hit = rules.find((m) => m.days === newStreak);
  return hit ? hit.xp : 0;
}
