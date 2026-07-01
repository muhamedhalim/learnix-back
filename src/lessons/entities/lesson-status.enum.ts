/**
 * Publishing state for an individual lesson within a course.
 * Existing lessons are backfilled to PUBLISHED so current behaviour is preserved.
 */
export enum LessonStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  HIDDEN = 'hidden',
}
