import { ReviewPolicy } from './review-policy.enum';

/**
 * Per-exam configuration, stored as JSONB on the exam. Grouped here (rather than
 * as scattered columns) because these are policy knobs read together by the
 * attempt engine, and the set will grow (proctoring, pools) without schema churn.
 */
export interface ExamConfig {
  /** Total time allowed per attempt, in seconds. */
  duration_seconds: number;
  /** How many attempts a student may take (>= 1). */
  attempts_allowed: number;
  /** Optional scheduling window (ISO strings). Enforced server-side. */
  start_window_at?: string | null;
  end_window_at?: string | null;
  /** Randomize question / choice order per attempt (deterministic via seed). */
  shuffle_questions: boolean;
  shuffle_choices: boolean;
  /** When students may review their results. */
  review_policy: ReviewPolicy;
  /** Subtract marks for wrong objective answers when true. */
  negative_marking: boolean;
  /** Show the auto-graded score immediately on submit (objective-only exams). */
  show_score_immediately: boolean;
  /** Extra seconds accepted after the deadline before a submit is rejected. */
  grace_seconds: number;
}

/** Sensible defaults applied when an exam is created. */
export const DEFAULT_EXAM_CONFIG: ExamConfig = {
  duration_seconds: 3600,
  attempts_allowed: 1,
  start_window_at: null,
  end_window_at: null,
  shuffle_questions: false,
  shuffle_choices: false,
  review_policy: ReviewPolicy.AFTER_GRADED,
  negative_marking: false,
  show_score_immediately: true,
  grace_seconds: 30,
};
