/**
 * Exam lifecycle status.
 *
 * - DRAFT: being authored; editable; not visible to students.
 * - PUBLISHED: live; visible to eligible students immediately.
 * - SCHEDULED: published but gated by a start/end window in exam config.
 * - ARCHIVED: retired; hidden from students, retained for records/analytics.
 *
 * Editing questions/structure is only allowed in DRAFT (published exams are
 * immutable so in-flight attempts and grading stay consistent).
 */
export enum ExamStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  SCHEDULED = 'scheduled',
  ARCHIVED = 'archived',
}
