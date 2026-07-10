import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

/** Which review table a helpful vote targets. */
export enum ReviewTargetType {
  LESSON = 'lesson',
  TEACHER = 'teacher',
}

/**
 * A single "helpful" vote by a user on a review. Polymorphic across the two
 * review tables (lesson/teacher). Uniqueness on (type, review, user) enforces
 * one vote per user per review; the denormalised `helpful_count` on each review
 * row is kept in sync by the service so lists don't need a COUNT subquery.
 */
@Entity('review_helpful_votes')
@Unique('UQ_review_helpful_vote', ['review_type', 'review_id', 'user_id'])
@Index('IDX_review_helpful_votes_target', ['review_type', 'review_id'])
@Index('IDX_review_helpful_votes_user', ['user_id'])
export class ReviewHelpfulVote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: ReviewTargetType, name: 'review_type' })
  review_type!: ReviewTargetType;

  @Column({ type: 'uuid', name: 'review_id' })
  review_id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
