import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { User } from '../../../users/entities/user.entity';
import { MarketplaceCourseReview } from './marketplace-course-review.entity';

/** An abuse report against a review. */
@Entity('marketplace_review_reports')
@Index('UQ_mp_review_reports_once', ['review_id', 'reporter_id'], { unique: true })
export class MarketplaceReviewReport {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'review_id' })
  review_id!: string;

  @ManyToOne(() => MarketplaceCourseReview, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'review_id' })
  review!: MarketplaceCourseReview;

  @Column({ type: 'uuid', name: 'reporter_id' })
  reporter_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'reporter_id' })
  reporter!: User;

  @Column({ type: 'text' })
  reason!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
