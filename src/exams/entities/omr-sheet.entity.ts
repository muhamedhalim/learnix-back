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
import type { OmrTemplate } from './omr-template.entity';
import type { OmrRecognizedAnswer } from './omr-template.types';
import { OmrSheetStatus } from './omr-sheet-status.enum';

/** One final, confirmed answer feeding the attempt engine (`AttemptService.saveAnswers`'s shape). */
export interface OmrDetectedAnswer {
  exam_question_id: string;
  response: QuestionResponsePayload | null;
}

/**
 * One physical OMR answer sheet, from generation through to grading.
 *
 * `image_key`/`detected_answers` are null until a scan is uploaded and
 * confirmed respectively — see `OmrSheetStatus` for the full lifecycle.
 * `recognized_answers` is the CV pipeline's raw, auditable output
 * (per-question confidence/status/fill-ratio metadata); `detected_answers` is
 * the FINAL, teacher-confirmed answer set in the exact shape the attempt
 * engine consumes — kept as two separate columns so a teacher's correction
 * never silently overwrites the original recognition evidence.
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

  /** The layout this sheet was printed/scanned against. Null only for legacy pre-recognition rows. */
  @Column({ type: 'uuid', nullable: true, name: 'template_id' })
  template_id!: string | null;

  @ManyToOne('OmrTemplate', { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'template_id' })
  template!: Relation<OmrTemplate> | null;

  /** Storage key for the uploaded scan image. Null until a scan is uploaded. */
  @Column({ type: 'varchar', length: 500, nullable: true, name: 'image_key' })
  image_key!: string | null;

  /**
   * Final, confirmed answers — same shape `saveAnswers` expects. Null until a
   * teacher confirms (or, for legacy rows created before this pipeline
   * existed, this was populated directly from client input at upload time).
   */
  @Column({ type: 'jsonb', nullable: true, name: 'detected_answers' })
  detected_answers!: OmrDetectedAnswer[] | null;

  /** Raw CV output per question — audit/debug trail, never the grading source of truth. */
  @Column({ type: 'jsonb', nullable: true, name: 'recognized_answers' })
  recognized_answers!: OmrRecognizedAnswer[] | null;

  /** Which flagged (low-confidence/multiple-marks) questions the teacher has explicitly addressed. */
  @Column({ type: 'jsonb', name: 'resolved_question_ids', default: () => "'[]'" })
  resolved_question_ids!: string[];

  /** Name/version of the `OmrRecognitionProvider` implementation that produced `recognized_answers`. */
  @Column({ type: 'varchar', length: 100, nullable: true, name: 'recognition_provider' })
  recognition_provider!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'confirmed_at' })
  confirmed_at!: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'reviewed_by' })
  reviewed_by!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'reviewed_by' })
  reviewer!: Relation<User> | null;

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
