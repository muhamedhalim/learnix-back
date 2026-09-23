import type { ApplicationCacheScopeInvalidation } from '../../common/cache/application-cache.service';

/**
 * Owner-scoped cache slices affected by a write to an exam attempt.
 *
 * Every family below is keyed `owner:<userId>` by its `getOrCompute` callers,
 * so the write invalidates exactly the two owners involved (the student who took
 * the exam, the teacher who owns it) instead of every owner's entries:
 *
 *  - student families read the student's own attempts, scores and progress;
 *  - teacher families read the attempts of students on the teacher's exams
 *    (`exam_analytics` is keyed by the exam's teacher, `analytics.service.ts`).
 *
 * Role-scoped families (`admin_dashboard`, `platform_report`) are not owner
 * scoped and stay on the route's family-level declaration.
 */
export const STUDENT_EXAM_FAMILIES = [
  'student_dashboard',
  'student_profile',
  'student_report',
] as const;

export const TEACHER_EXAM_FAMILIES = ['teacher_report', 'exam_analytics'] as const;

/**
 * Teacher quiz analytics (`teacher_quiz_analytics`, T039) reads only attempts that
 * reached SUBMITTED, GRADING or GRADED, so it is affected by a finalization or a
 * manual grade but NOT by starting an attempt (IN_PROGRESS is excluded).
 */
export function teacherQuizCacheScopes(teacherId: string): ApplicationCacheScopeInvalidation[] {
  return [{ family: 'teacher_quiz_analytics', scope: `owner:${teacherId}` }];
}

export function studentExamCacheScopes(studentId: string): ApplicationCacheScopeInvalidation[] {
  return STUDENT_EXAM_FAMILIES.map((family) => ({ family, scope: `owner:${studentId}` }));
}

export function teacherExamCacheScopes(teacherId: string): ApplicationCacheScopeInvalidation[] {
  return TEACHER_EXAM_FAMILIES.map((family) => ({ family, scope: `owner:${teacherId}` }));
}
