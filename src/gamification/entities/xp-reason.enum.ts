/** Why an XP award happened. Drives the append-only `xp_events` ledger. */
export enum XpReason {
  CORRECT_ANSWER = 'correct_answer',
  COMBO_BONUS = 'combo_bonus',
  STREAK_DAILY = 'streak_daily',
  STREAK_MILESTONE = 'streak_milestone',
  PERFECT_EXAM = 'perfect_exam',
  LESSON_COMPLETION = 'lesson_completion',
  COURSE_COMPLETION = 'course_completion',
  // Reserved for later milestones:
  DAILY_CHALLENGE = 'daily_challenge',
  WEEKLY_CHALLENGE = 'weekly_challenge',
  ACHIEVEMENT = 'achievement',
}
