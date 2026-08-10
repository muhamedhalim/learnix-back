import type { Relation } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { AttemptState } from './attempt-state.enum';
import type { ExamAttemptAnswer } from './exam-attempt-answer.entity';
import type { Exam } from './exam.entity';
import { numericTransformer } from './numeric.transformer';

/** How an attempt was created — see the `origin` column doc comment below. */
export type AttemptOrigin = 'online' | 'omr';

/**
 * A single student attempt at an exam. Timing is server-authoritative:
 * `deadline_at` is computed from `started_at + duration` and enforced on submit
 * and lazily on read (so time cannot be manipulated client-side).
 *
 * Multiple attempts are supported via `attempt_number`; a partial unique index
 * (added in the migration) guarantees at most one IN_PROGRESS attempt per
 * (exam, student) so concurrent starts can't create duplicates.
 */
@Entity('exam_attempts')
@Unique('UQ_exam_attempts_exam_student_number', ['exam_id', 'student_id', 'attempt_number'])
// At most one IN_PROGRESS attempt per (exam, student): makes concurrent "start"
// clicks fail atomically at the DB (translated to a clean 409 by the service).
@Index('UQ_exam_attempts_open_per_student', ['exam_id', 'student_id'], {
  unique: true,
  where: "state = 'in_progress'",
})
// Idempotent submit: a submit idempotency key is unique when present.
@Index('UQ_exam_attempts_idempotency', ['idempotency_key'], {
  unique: true,
  where: '"idempotency_key" IS NOT NULL',
})
@Index('IDX_exam_attempts_exam_id', ['exam_id'])
@Index('IDX_exam_attempts_student_id', ['student_id'])
@Index('IDX_exam_attempts_state', ['state'])
export class ExamAttempt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'exam_id' })
  exam_id!: string;

  @ManyToOne('Exam', 'attempts', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'exam_id' })
  exam!: Relation<Exam>;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'int', name: 'attempt_number', default: 1 })
  attempt_number!: number;

  @Column({
    type: 'enum',
    enum: AttemptState,
    default: AttemptState.IN_PROGRESS,
  })
  state!: AttemptState;

  /** Seed for deterministic question/choice shuffling (stable across resumes). */
  @Column({ type: 'int', name: 'shuffle_seed', default: 0 })
  shuffle_seed!: number;

  @Column({ type: 'timestamptz', name: 'started_at' })
  started_at!: Date;

  @Column({ type: 'timestamptz', name: 'deadline_at' })
  deadline_at!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'submitted_at' })
  submitted_at!: Date | null;

  @Column({ type: 'boolean', name: 'auto_submitted', default: false })
  auto_submitted!: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'graded_at' })
  graded_at!: Date | null;

  @Column({
    type: 'numeric',
    precision: 9,
    scale: 2,
    nullable: true,
    name: 'score_auto',
    transformer: numericTransformer,
  })
  score_auto!: number | null;

  @Column({
    type: 'numeric',
    precision: 9,
    scale: 2,
    nullable: true,
    name: 'score_manual',
    transformer: numericTransformer,
  })
  score_manual!: number | null;

  @Column({
    type: 'numeric',
    precision: 9,
    scale: 2,
    nullable: true,
    name: 'score_total',
    transformer: numericTransformer,
  })
  score_total!: number | null;

  @Column({
    type: 'numeric',
    precision: 9,
    scale: 2,
    name: 'max_score',
    default: 0,
    transformer: numericTransformer,
  })
  max_score!: number;

  @Column({ type: 'boolean', nullable: true })
  passed!: boolean | null;

  /** Opaque token identifying the active client session for this attempt. */
  @Column({ type: 'uuid', name: 'session_token' })
  session_token!: string;

  /** Idempotency guard for submit (prevents duplicate finalisation). */
  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
    name: 'idempotency_key',
  })
  idempotency_key!: string | null;

  /**
   * How this attempt was created: `'online'` (student-driven, the default —
   * `startAttempt`) or `'omr'` (teacher-driven, confirm-time — see
   * `AttemptService.createOmrAttempt`). Lets the OMR confirm path tell a
   * genuine live/finalised online session apart from its own prior attempt
   * for the same (exam, student), instead of silently reusing either.
   */
  @Column({ type: 'varchar', length: 20, default: 'online' })
  origin!: AttemptOrigin;

  @OneToMany('ExamAttemptAnswer', 'attempt')
  answers!: Relation<ExamAttemptAnswer[]>;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
