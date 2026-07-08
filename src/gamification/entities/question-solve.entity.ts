import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Difficulty } from '../../exams/entities/difficulty.enum';
import type { QuestionResponsePayload } from '../../exams/entities/content.types';
import { numericTransformer } from '../../exams/entities/numeric.transformer';

/**
 * Append-only ledger of every practice solve event. Immutable source of truth
 * for recent-activity feeds, per-question analytics, and anti-abuse forensics.
 * Denormalises subject/lesson/difficulty so analytics never re-join `questions`.
 */
@Entity('question_solves')
@Index('IDX_question_solves_user_created', ['user_id', 'created_at'])
export class QuestionSolve {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @Column({ type: 'uuid', name: 'question_id' })
  @Index('IDX_question_solves_question_id')
  question_id!: string;

  @Column({ type: 'int', name: 'question_version' })
  question_version!: number;

  @Column({ type: 'uuid', name: 'subject_id' })
  subject_id!: string;

  @Column({ type: 'uuid', name: 'lesson_id', nullable: true })
  lesson_id!: string | null;

  @Column({ type: 'enum', enum: Difficulty })
  difficulty!: Difficulty;

  @Column({ type: 'jsonb', nullable: true })
  response!: QuestionResponsePayload | null;

  @Column({ type: 'boolean', name: 'is_correct' })
  is_correct!: boolean;

  @Column({ type: 'int', name: 'time_ms', default: 0 })
  time_ms!: number;

  @Column({ type: 'int', name: 'xp_awarded', default: 0 })
  xp_awarded!: number;

  @Column({ type: 'numeric', precision: 8, scale: 2, name: 'rating_delta', default: 0, transformer: numericTransformer })
  rating_delta!: number;

  @Column({ type: 'int', name: 'combo_at_time', default: 0 })
  combo_at_time!: number;

  /** True when this was the first correct solve (the XP/rating-earning event). */
  @Column({ type: 'boolean', name: 'first_solve', default: false })
  first_solve!: boolean;

  /** Flagged suspicious (e.g. under the min-time floor). Kept for forensics. */
  @Column({ type: 'boolean', default: false })
  suspicious!: boolean;

  @Column({ type: 'uuid', name: 'session_id', nullable: true })
  session_id!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  @Index('IDX_question_solves_created_at')
  created_at!: Date;
}
