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
} from 'typeorm';

import type { QuestionContent, QuestionAnswerKey } from './content.types';
import type { Question } from './question.entity';
import { QuestionType } from './question-type.enum';

/**
 * Immutable snapshot of a question at a point in time. When a question is edited
 * a new version row is written; existing exams keep pointing at the version they
 * were built against, so grading is always deterministic and reproducible even
 * after the bank question changes. This is the durable audit history; exams also
 * snapshot the pinned version onto their `exam_questions` for hot-path reads.
 */
@Entity('question_versions')
@Unique('UQ_question_versions_question_version', ['question_id', 'version'])
export class QuestionVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'question_id' })
  @Index('IDX_question_versions_question_id')
  question_id!: string;

  @ManyToOne('Question', 'versions', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'question_id' })
  question!: Relation<Question>;

  @Column({ type: 'int' })
  version!: number;

  @Column({ type: 'enum', enum: QuestionType })
  type!: QuestionType;

  @Column({ type: 'jsonb' })
  content!: QuestionContent;

  @Column({ type: 'jsonb', name: 'answer_key' })
  answer_key!: QuestionAnswerKey;

  @Column({ type: 'int', name: 'default_marks' })
  default_marks!: number;

  @Column({ type: 'uuid', name: 'created_by' })
  created_by!: string;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;
}
