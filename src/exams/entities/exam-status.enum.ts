/**
 * Exam attempt status enum
 *
 * Status transitions:
 * - IN_PROGRESS: Student has started but not submitted
 * - SUBMITTED: Student has submitted (intermediate state)
 * - PENDING_GRADING: Submitted with essay questions awaiting manual grading
 * - GRADED: All questions graded (MCQ auto-graded, essays manually graded)
 */
export enum ExamStatus {
  IN_PROGRESS = 'in_progress',
  SUBMITTED = 'submitted',
  PENDING_GRADING = 'pending_grading',
  GRADED = 'graded',
}
