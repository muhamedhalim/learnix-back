import type { Subject } from '../entities/subject.entity';

/**
 * Subject with aggregated counts for listing
 */
export interface SubjectWithCounts extends Subject {
  teachersCount: number;
  lessonsCount: number;
}

/**
 * Admin listing projection: adds the resolved owner name so the admin table can
 * show who submitted a subject without a second round-trip.
 */
export interface SubjectAdminView extends SubjectWithCounts {
  /** Owning teacher's display name, or null for platform-owned subjects. */
  owner_name: string | null;
}
