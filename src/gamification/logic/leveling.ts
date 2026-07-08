import { LEVEL_BASE_XP, LEVEL_GROWTH } from '../gamification.constants';

/**
 * Level curve. Cumulative XP required to *reach* level `n` grows super-linearly:
 *   xpForLevel(1) = 0, xpForLevel(n) = floor(BASE * (n-1)^GROWTH).
 * Pure + deterministic so it is trivially unit-testable.
 */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.floor(LEVEL_BASE_XP * Math.pow(level - 1, LEVEL_GROWTH));
}

/** Highest level whose XP threshold is satisfied by `xp`. */
export function levelForXp(xp: number): number {
  if (xp <= 0) return 1;
  let level = 1;
  // Thresholds are monotonic; walk up until the next level is out of reach.
  while (xpForLevel(level + 1) <= xp) {
    level += 1;
  }
  return level;
}

/** Progress within the current level: {current, needed} XP toward the next level. */
export function levelProgress(xp: number): {
  level: number;
  intoLevel: number;
  span: number;
  nextLevelXp: number;
} {
  const level = levelForXp(xp);
  const floorXp = xpForLevel(level);
  const nextLevelXp = xpForLevel(level + 1);
  return {
    level,
    intoLevel: xp - floorXp,
    span: Math.max(1, nextLevelXp - floorXp),
    nextLevelXp,
  };
}
