import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../../users/entities/user.entity';
import { MarketplaceCourse } from '../../catalog/entities';
import { MarketplaceEnrollment } from '../../commerce/entities';
import { CourseReviewStatus } from '../../common/enums';

/** FR-253 – FR-266. A learner's rating and optional comment on a course. */
@Entity('marketplace_course_reviews')
@Index('UQ_mp_reviews_learner_course', ['learner_id', 'course_id'], { unique: true })
@Index('IDX_mp_reviews_course_visible', ['course_id', 'status', 'created_at'])
@Check('CHK_mp_reviews_rating', '"rating" BETWEEN 1 AND 5')
export class MarketplaceCourseReview {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'course_id' })
  course_id!: string;

  @ManyToOne(() => MarketplaceCourse, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'course_id' })
  course!: MarketplaceCourse;

  @Column({ type: 'uuid', name: 'enrollment_id' })
  enrollment_id!: string;

  @ManyToOne(() => MarketplaceEnrollment, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'enrollment_id' })
  enrollment!: MarketplaceEnrollment;

  @Column({ type: 'uuid', name: 'learner_id' })
  learner_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'learner_id' })
  learner!: User;

  @Column({ type: 'int' })
  rating!: number;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ type: 'varchar', length: 20, default: CourseReviewStatus.APPROVED })
  status!: CourseReviewStatus;

  @Column({ type: 'text', nullable: true, name: 'instructor_reply' })
  instructor_reply!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'instructor_reply_at' })
  instructor_reply_at!: Date | null;

  @Column({ type: 'int', default: 0, name: 'report_count' })
  report_count!: number;

  @Column({ type: 'uuid', nullable: true, name: 'moderated_by' })
  moderated_by!: string | null;

  @Column({ type: 'text', nullable: true, name: 'moderation_reason' })
  moderation_reason!: string | null;

  /** FR-191, FR-263 — set when the underlying purchase is refunded (T136). `status` is left untouched. */
  @Column({ type: 'timestamptz', nullable: true, name: 'withdrawn_at' })
  withdrawn_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
