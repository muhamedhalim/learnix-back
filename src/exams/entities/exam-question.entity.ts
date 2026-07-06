import type { Relation } from 'typeorm';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import type { QuestionContent, QuestionAnswerKey } from './content.types';
import type { Exam } from './exam.entity';
import type { ExamSection } from './exam-section.entity';
import type { Question } from './question.entity';
import { QuestionType } from './question-type.enum';
import { numericTransformer } from './numeric.transformer';

/**
 * A bank question placed into an exam. Reusable questions become concrete exam
 * items here, with per-exam overrides (marks, weight, bonus, required, order).
 *
 * At attach time the pinned question version's `type`, `content`, and
 * `answer_key` are SNAPSHOT onto this row. This makes a published exam fully
 * self-contained: rendering and grading never depend on the (mutable) bank
 * question, guaranteeing in-flight attempts and historical results stay stable.
 */
@Entity('exam_questions')
@Unique('UQ_exam_questions_exam_question', ['exam_id', 'question_id'])
export class ExamQuestion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'exam_id' })
  @Index('IDX_exam_questions_exam_id')
  exam_id!: string;

  @ManyToOne('Exam', 'exam_questions', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'exam_id' })
  exam!: Relation<Exam>;

  @Column({ type: 'uuid', name: 'section_id' })
  @Index('IDX_exam_questions_section_id')
  section_id!: string;

  @ManyToOne('ExamSection', 'exam_questions', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'section_id' })
  section!: Relation<ExamSection>;

  @Column({ type: 'uuid', name: 'question_id' })
  @Index('IDX_exam_questions_question_id')
  question_id!: string;

  @ManyToOne('Question', { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'question_id' })
  question!: Relation<Question>;

  /** The pinned bank version this exam item was built from. */
  @Column({ type: 'int', name: 'question_version' })
  question_version!: number;

  // ---- Snapshot of the pinned version (self-contained grading) ----
  @Column({ type: 'enum', enum: QuestionType, name: 'type_snapshot' })
  type_snapshot!: QuestionType;

  @Column({ type: 'jsonb', name: 'content_snapshot' })
  content_snapshot!: QuestionContent;

  @Column({ type: 'jsonb', name: 'answer_key_snapshot' })
  answer_key_snapshot!: QuestionAnswerKey;
  // -----------------------------------------------------------------

  @Column({ type: 'int', name: 'order_index', default: 0 })
  order_index!: number;

  @Column({ type: 'int' })
  marks!: number;

  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 1,
    transformer: numericTransformer,
  })
  weight!: number;

  @Column({ type: 'boolean', name: 'is_bonus', default: false })
  is_bonus!: boolean;

  @Column({ type: 'boolean', default: true })
  required!: boolean;
}
