import type { Relation } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import type { LessonHomework } from './lesson-homework.entity';

export type HomeworkSubmissionStatus = 'submitted' | 'graded';

/**
 * One student's response to a lesson assignment. A unique row per
 * (homework, student) makes resubmission an update rather than a duplicate,
 * while the timestamps preserve when the latest answer was handed in.
 */
@Entity('homework_submissions')
@Unique('UQ_homework_submissions_homework_student', ['homework_id', 'student_id'])
@Index('IDX_homework_submissions_homework_id', ['homework_id'])
@Index('IDX_homework_submissions_student_id', ['student_id'])
@Index('IDX_homework_submissions_status', ['status'])
export class HomeworkSubmission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  homework_id!: string;

  @ManyToOne('LessonHomework', 'submissions', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'homework_id' })
  homework!: Relation<LessonHomework>;

  @Column('uuid')
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  /** Optional free-form response for non-question assignments. */
  @Column('text', { nullable: true })
  answer_text!: string | null;

  /** Answers keyed by the assignment question id. */
  @Column('jsonb', { default: () => "'[]'::jsonb" })
  answers!: Array<{ question_id: string; answer: string }>;

  /** Public URL returned by the authenticated homework upload endpoint. */
  @Column({ type: 'varchar', length: 1000, nullable: true })
  resource_url!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'submitted' })
  status!: HomeworkSubmissionStatus;

  @Column({ type: 'boolean', default: false })
  is_late!: boolean;

  @Column({ type: 'numeric', precision: 9, scale: 2, nullable: true })
  score!: number | null;

  @Column('text', { nullable: true })
  feedback!: string | null;

  @Column({ type: 'timestamptz' })
  submitted_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  graded_at!: Date | null;

  @Column('uuid', { nullable: true })
  graded_by!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'graded_by' })
  grader!: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
