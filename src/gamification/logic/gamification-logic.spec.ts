import { Difficulty } from '../../exams/entities/difficulty.enum';
import { actualScore, expectedScore, kFactor, ratingDelta } from './elo';
import { levelForXp, levelProgress, xpForLevel } from './leveling';
import { appDateString, dayDiff, nextStreak } from './streak';
import { baseXpForDifficulty, comboBonusFor, streakMilestoneBonusFor } from './xp-rules';

describe('leveling', () => {
  it('level 1 needs 0 xp and is monotonic', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(-5)).toBe(1);
    for (let l = 1; l < 20; l++) {
      expect(xpForLevel(l + 1)).toBeGreaterThan(xpForLevel(l));
    }
  });

  it('levelForXp is the inverse of xpForLevel at thresholds', () => {
    for (let l = 1; l < 15; l++) {
      expect(levelForXp(xpForLevel(l))).toBe(l);
      expect(levelForXp(xpForLevel(l + 1) - 1)).toBe(l);
    }
  });

  it('levelProgress reports position within a level', () => {
    const p = levelProgress(xpForLevel(3) + 5);
    expect(p.level).toBe(3);
    expect(p.intoLevel).toBe(5);
    expect(p.span).toBeGreaterThan(0);
  });
});

describe('elo', () => {
  it('expected score is 0.5 for equal ratings and monotonic in gap', () => {
    expect(expectedScore(1200, 1200)).toBeCloseTo(0.5, 5);
    expect(expectedScore(1600, 1200)).toBeGreaterThan(0.5);
    expect(expectedScore(1000, 1200)).toBeLessThan(0.5);
  });

  it('k-factor decays with volume', () => {
    expect(kFactor(0)).toBeGreaterThan(kFactor(30));
    expect(kFactor(30)).toBeGreaterThan(kFactor(100));
  });

  it('actual score: wrong=0, correct>=1 with mild speed bonus', () => {
    expect(actualScore(false, 100)).toBe(0);
    expect(actualScore(true, 999_999)).toBe(1);
    expect(actualScore(true, 0)).toBeGreaterThan(1);
    expect(actualScore(true, 0)).toBeLessThanOrEqual(1.15 + 1e-9);
  });

  it('rating rises on an upset win and falls on a miss', () => {
    // Weak student beats a hard question → positive delta.
    const win = ratingDelta({ studentRating: 1000, questionRating: 1600, isCorrect: true, timeMs: 10_000, solvedCount: 0 });
    expect(win).toBeGreaterThan(0);
    // Strong student misses an easy question → negative delta.
    const loss = ratingDelta({ studentRating: 1600, questionRating: 1000, isCorrect: false, timeMs: 10_000, solvedCount: 0 });
    expect(loss).toBeLessThan(0);
  });
});

describe('xp-rules', () => {
  it('base xp increases with difficulty', () => {
    expect(baseXpForDifficulty(Difficulty.EASY)).toBeLessThan(baseXpForDifficulty(Difficulty.MEDIUM));
    expect(baseXpForDifficulty(Difficulty.MEDIUM)).toBeLessThan(baseXpForDifficulty(Difficulty.HARD));
    expect(baseXpForDifficulty(Difficulty.HARD)).toBeLessThan(baseXpForDifficulty(Difficulty.EXPERT));
    expect(baseXpForDifficulty(null)).toBe(baseXpForDifficulty(Difficulty.MEDIUM));
  });

  it('combo bonus only fires exactly on milestones', () => {
    expect(comboBonusFor(4)).toBe(0);
    expect(comboBonusFor(5)).toBeGreaterThan(0);
    expect(comboBonusFor(6)).toBe(0);
    expect(comboBonusFor(10)).toBeGreaterThan(0);
  });

  it('streak milestone bonus only fires on milestones', () => {
    expect(streakMilestoneBonusFor(6)).toBe(0);
    expect(streakMilestoneBonusFor(7)).toBeGreaterThan(0);
    expect(streakMilestoneBonusFor(30)).toBeGreaterThan(0);
  });
});

describe('streak', () => {
  it('formats an app-timezone date and diffs days', () => {
    expect(appDateString(new Date('2026-01-15T00:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dayDiff('2026-01-01', '2026-01-02')).toBe(1);
    expect(dayDiff('2026-01-01', '2026-01-01')).toBe(0);
    expect(dayDiff('2026-01-01', '2026-02-01')).toBe(31);
  });

  it('transitions: start / extend / same-day / reset', () => {
    expect(nextStreak(0, null, '2026-01-10')).toEqual({ streak: 1, transition: 'started' });
    expect(nextStreak(3, '2026-01-09', '2026-01-10')).toEqual({ streak: 4, transition: 'extended' });
    expect(nextStreak(3, '2026-01-10', '2026-01-10')).toEqual({ streak: 3, transition: 'same_day' });
    expect(nextStreak(9, '2026-01-05', '2026-01-10')).toEqual({ streak: 1, transition: 'reset' });
  });
});
