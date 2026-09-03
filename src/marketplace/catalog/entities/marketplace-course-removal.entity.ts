import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CourseRemovalCause } from '../../common/enums';
import { MarketplaceCourse } from './marketplace-course.entity';

/**
 * FR-054a. Records *what* a permanent removal did — the three columns on
 * `MarketplaceCourse` mark only *that* it happened (data-model.md §2).
 * `completed_at` stays NULL while the per-learner refund fan-out runs, so a
 * partially-completed removal is visible rather than silent.
 */
@Entity('marketplace_course_removals')
@Index('UQ_mp_course_removals_course', ['course_id'], { unique: true })
export class MarketplaceCourseRemoval {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'course_id' })
  course_id!: string;

  @ManyToOne(() => MarketplaceCourse, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'course_id' })
  course!: MarketplaceCourse;

  @Column({ type: 'varchar', length: 30 })
  cause!: CourseRemovalCause;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'uuid', name: 'removed_by' })
  removed_by!: string;

  @Column({ type: 'timestamptz', name: 'removed_at', default: () => 'now()' })
  removed_at!: Date;

  @Column({ type: 'int', default: 0, name: 'enrollments_revoked' })
  enrollments_revoked!: number;

  @Column({ type: 'int', default: 0, name: 'refunds_issued' })
  refunds_issued!: number;

  @Column({ type: 'int', default: 0, name: 'refunds_failed' })
  refunds_failed!: number;

  @Column({ type: 'bigint', default: 0, name: 'earnings_reversed_minor' })
  earnings_reversed_minor!: number;

  @Column({ type: 'char', length: 3, nullable: true })
  currency!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completed_at!: Date | null;
}
