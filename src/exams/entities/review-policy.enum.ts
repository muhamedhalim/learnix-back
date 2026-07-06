/**
 * When a student may see their answers/correct answers/score for an attempt.
 *
 * - NEVER: results never shown to the student.
 * - AFTER_SUBMIT: immediately after submitting.
 * - AFTER_CLOSE: only after the exam end-window closes.
 * - AFTER_GRADED: only once the attempt is fully graded (default).
 */
export enum ReviewPolicy {
  NEVER = 'never',
  AFTER_SUBMIT = 'after_submit',
  AFTER_CLOSE = 'after_close',
  AFTER_GRADED = 'after_graded',
}
