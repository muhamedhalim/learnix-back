/**
 * Publishing lifecycle for a course (formerly "lesson package").
 * Kept additive so existing packages keep working: a previously-active package
 * is backfilled to PUBLISHED, an inactive one to DRAFT.
 */
export enum CourseStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  HIDDEN = 'hidden',
  ARCHIVED = 'archived',
}
