/**
 * The catalogue of educational events a guardian can be notified about.
 *
 * Lives in `common` rather than in the notifications module because two
 * otherwise-independent domains key off it: the notification pipeline (which
 * routes an event to a template) and the guardian domain (whose per-student
 * notification preferences are a map from this enum to a boolean). Putting it
 * here keeps `guardians` and `notifications` from importing each other.
 *
 * The string values are persisted (in `parent_messages.event_type` and inside
 * the `student_guardians.notification_preferences` JSON), so they are part of
 * the database contract — rename with a migration, never in place.
 */
export enum ParentEventType {
  EXAM_GRADED = 'exam_graded',
  ATTENDANCE_MARKED = 'attendance_marked',
  HOMEWORK_ASSIGNED = 'homework_assigned',
  LESSON_COMPLETED = 'lesson_completed',
  COURSE_PURCHASED = 'course_purchased',
  WEEKLY_REPORT = 'weekly_report',
  MONTHLY_REPORT = 'monthly_report',
  GUARDIAN_VERIFICATION = 'guardian_verification',
  /** A teacher's free-text broadcast (class / absentees / low grades). */
  TEACHER_MESSAGE = 'teacher_message',
}

/**
 * Default opt-in state per event, applied when a guardian link has no explicit
 * preference stored. Verification codes are transactional and deliberately
 * absent — they are never subject to a marketing-style opt-out.
 */
export const DEFAULT_PARENT_NOTIFICATION_PREFERENCES: Readonly<
  Record<Exclude<ParentEventType, ParentEventType.GUARDIAN_VERIFICATION>, boolean>
> = Object.freeze({
  [ParentEventType.EXAM_GRADED]: true,
  [ParentEventType.ATTENDANCE_MARKED]: true,
  [ParentEventType.HOMEWORK_ASSIGNED]: true,
  [ParentEventType.LESSON_COMPLETED]: true,
  [ParentEventType.COURSE_PURCHASED]: true,
  [ParentEventType.WEEKLY_REPORT]: true,
  [ParentEventType.MONTHLY_REPORT]: true,
  [ParentEventType.TEACHER_MESSAGE]: true,
});

/** Transactional events that bypass guardian opt-out and verification gating. */
export const TRANSACTIONAL_PARENT_EVENTS: ReadonlySet<ParentEventType> = new Set([
  ParentEventType.GUARDIAN_VERIFICATION,
]);
