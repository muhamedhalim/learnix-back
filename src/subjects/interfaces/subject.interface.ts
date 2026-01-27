import type { Subject } from '../entities/subject.entity';

/**
 * Subject with aggregated counts for listing
 */
export interface SubjectWithCounts extends Subject {
  teachersCount: number;
  lessonsCount: number;
}
