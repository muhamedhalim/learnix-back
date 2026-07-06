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

import type { QuestionResponsePayload } from './content.types';
import type { ExamAttempt } from './exam-attempt.entity';
import type { ExamQuestion } from './exam-question.entity';
import { numericTransformer } from './numeric.transformer';

/**
 * One row per (attempt, question). Replaces the legacy JSONB `answers` array
 * indexed by position. Per-row storage is what unlocks partial save/resume,
 * incremental grading, concurrency-safe autosave upserts, and per-question
 * analytics (difficulty/discrimination) without scanning blobs.
 */
@Entity('exam_attempt_answers')
@Unique('UQ_exam_attempt_answers_attempt_question', [
  'attempt_id',
  'exam_question_id',
])
export class ExamAttemptAnswer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'attempt_id' })
  @Index('IDX_exam_attempt_answers_attempt_id')
  attempt_id!: string;

  @ManyToOne('ExamAttempt', 'answers', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'attempt_id' })
  attempt!: Relation<ExamAttempt>;

  @Column({ type: 'uuid', name: 'exam_question_id' })
  @Index('IDX_exam_attempt_answers_exam_question_id')
  exam_question_id!: string;

  @ManyToOne('ExamQuestion', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'exam_question_id' })
  exam_question!: Relation<ExamQuestion>;

  /** Denormalised for analytics/grading without joining exam_questions. */
  @Column({ type: 'uuid', name: 'question_id' })
  @Index('IDX_exam_attempt_answers_question_id')
  question_id!: string;

  @Column({ type: 'int', name: 'question_version' })
  question_version!: number;

  /** Position of this question within the rendered attempt form. */
  @Column({ type: 'int', name: 'order_index', default: 0 })
  order_index!: number;

  /** The student's response payload (type-specific). Null = unanswered. */
  @Column({ type: 'jsonb', nullable: true })
  response!: QuestionResponsePayload | null;

  @Column({
    type: 'numeric',
    precision: 9,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  score!: number | null;

  @Column({
    type: 'numeric',
    precision: 9,
    scale: 2,
    name: 'max_score',
    default: 0,
    transformer: numericTransformer,
  })
  max_score!: number;

  @Column({ type: 'boolean', name: 'auto_graded', default: false })
  auto_graded!: boolean;

  @Column({ type: 'boolean', name: 'manual_required', default: false })
  manual_required!: boolean;

  /** Objective correctness (null for manual/partial types). */
  @Column({ type: 'boolean', nullable: true, name: 'is_correct' })
  is_correct!: boolean | null;

  @Column({ type: 'uuid', nullable: true, name: 'graded_by' })
  graded_by!: string | null;

  @Column({ type: 'text', nullable: true })
  feedback!: string | null;

  @Column({
    type: 'numeric',
    precision: 9,
    scale: 2,
    nullable: true,
    name: 'ai_suggested_score',
    transformer: numericTransformer,
  })
  ai_suggested_score!: number | null;

  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: true,
    name: 'ai_confidence',
    transformer: numericTransformer,
  })
  ai_confidence!: number | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'answered_at' })
  answered_at!: Date | null;

  @Column({ type: 'int', name: 'time_spent_ms', default: 0 })
  time_spent_ms!: number;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
