/**
 * FR-059, FR-060. Six states, no seventh — permanent removal (FR-054a) is
 * layered on top of `UNPUBLISHED` via `removed_at`/`removal_reason`, never a
 * new value here. Named distinctly from the academic `CourseStatus` enum
 * (packages/entities/course-status.enum.ts) — the two are unrelated by
 * design (FR-003).
 */
export enum MarketplaceCourseStatus {
  DRAFT = 'draft',
  SUBMITTED_FOR_REVIEW = 'submitted_for_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  PUBLISHED = 'published',
  UNPUBLISHED = 'unpublished',
}
