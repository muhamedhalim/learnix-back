import type { Subject } from '../entities/subject.entity';

/**
 * Subject with aggregated relationship counts for listing.
 *
 * All three are real `COUNT`s over the canonical relations — see
 * `SubjectsService.loadSubjectCounts` for the exact definitions and why draft
 * content is included.
 */
export interface SubjectWithCounts extends Subject {
  /** Approved, non-deleted teachers linked through `teacher_subjects`. */
  teachersCount: number;
  /** Non-deleted lessons carrying this `subject_id`, in any publishing state. */
  lessonsCount: number;
  /** Non-deleted courses carrying this `subject_id`, in any publishing state. */
  coursesCount: number;
}

/**
 * Admin listing projection: adds the resolved owner name so the admin table can
 * show who submitted a subject without a second round-trip.
 */
export interface SubjectAdminView extends SubjectWithCounts {
  /** Owning teacher's display name, or null for platform-owned subjects. */
  owner_name: string | null;
}
