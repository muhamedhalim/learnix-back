import type { Relation } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import type { QuestionResponsePayload } from './content.types';
import type { Exam } from './exam.entity';
import type { ExamAttempt } from './exam-attempt.entity';
import { OmrSheetStatus } from './omr-sheet-status.enum';

/** One detected answer from an (externally-scanned/entered) OMR answer sheet. */
export interface OmrDetectedAnswer {
  exam_question_id: string;
  response: QuestionResponsePayload | null;
}

/**
 * A submitted OMR answer sheet: the uploaded scan image (kept for audit) plus
 * the already-detected marks (structured JSON — this pipeline does not itself
 * perform image/bubble detection, see `OmrProcessor`). Processing is queued
 * and asynchronous; `status`/`error_message`/`attempt_id` track the outcome.
 */
@Entity('omr_sheets')
@Index('IDX_omr_sheets_exam_id', ['exam_id'])
@Index('IDX_omr_sheets_student_id', ['student_id'])
@Index('IDX_omr_sheets_status', ['status'])
export class OmrSheet {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'exam_id' })
  exam_id!: string;

  @ManyToOne('Exam', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'exam_id' })
  exam!: Relation<Exam>;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: Relation<User>;

  @Column({ type: 'uuid', name: 'teacher_id' })
  teacher_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'teacher_id' })
  teacher!: Relation<User>;

  /** Storage key for the uploaded scan image (kept for audit; not analyzed). */
  @Column({ type: 'varchar', length: 500, name: 'image_key' })
  image_key!: string;

  /** Pre-detected marks, as submitted (structured input, not CV output). */
  @Column({ type: 'jsonb', name: 'detected_answers' })
  detected_answers!: OmrDetectedAnswer[];

  @Column({ type: 'enum', enum: OmrSheetStatus, default: OmrSheetStatus.PENDING })
  status!: OmrSheetStatus;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  error_message!: string | null;

  /** Set once processing creates/reuses the resulting attempt. */
  @Column({ type: 'uuid', nullable: true, name: 'attempt_id' })
  attempt_id!: string | null;

  @ManyToOne('ExamAttempt', { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'attempt_id' })
  attempt!: Relation<ExamAttempt> | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'processed_at' })
  processed_at!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
