import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CourseReviewDecisionValue } from '../../common/enums';
import { MarketplaceCourse } from './marketplace-course.entity';

/** An administrator's ruling on a submission (FR-066) — distinct from a learner's rating. */
@Entity('marketplace_course_review_decisions')
@Index('IDX_mp_course_decisions_course_reviewed', ['course_id', 'reviewed_at'])
export class MarketplaceCourseReviewDecision {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'course_id' })
  course_id!: string;

  @ManyToOne(() => MarketplaceCourse, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'course_id' })
  course!: MarketplaceCourse;

  @Column({ type: 'varchar', length: 20 })
  decision!: CourseReviewDecisionValue;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  reasons!: string[];

  @Column({ type: 'jsonb', default: () => "'{}'", name: 'item_notes' })
  item_notes!: Record<string, unknown>;

  @Column({ type: 'uuid', name: 'reviewed_by' })
  reviewed_by!: string;

  @Column({ type: 'timestamptz', name: 'reviewed_at', default: () => 'now()' })
  reviewed_at!: Date;
}
