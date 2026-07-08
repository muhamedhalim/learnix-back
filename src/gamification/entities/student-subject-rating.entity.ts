import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { numericTransformer } from '../../exams/entities/numeric.transformer';

/**
 * Per-(student, subject) Elo rating — the backbone of per-subject leaderboards
 * and the source the global rating aggregates from. One row per subject the
 * student has ever practiced.
 */
@Entity('student_subject_ratings')
@Unique('UQ_student_subject_ratings_user_subject', ['user_id', 'subject_id'])
@Index('IDX_student_subject_ratings_board', ['subject_id', 'rating'])
export class StudentSubjectRating {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  @Index('IDX_student_subject_ratings_user_id')
  user_id!: string;

  @Column({ type: 'uuid', name: 'subject_id' })
  subject_id!: string;

  @Column({ type: 'numeric', precision: 8, scale: 2, default: 1200, transformer: numericTransformer })
  @Index('IDX_student_subject_ratings_subject_rating')
  rating!: number;

  @Column({ type: 'int', default: 0 })
  solved!: number;

  @Column({ type: 'int', default: 0 })
  correct!: number;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
