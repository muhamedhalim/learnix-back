import type { Relation } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Lesson } from '../../lessons/entities/lesson.entity';
import { Subject } from '../../subjects/entities/subject.entity';
import { User } from '../../users/entities/user.entity';
import { BloomLevel } from './bloom-level.enum';
import type { QuestionContent, QuestionAnswerKey } from './content.types';
import { Difficulty } from './difficulty.enum';
import type { QuestionVersion } from './question-version.entity';
import { QuestionType } from './question-type.enum';

/**
 * A reusable question in the bank. This is the single biggest departure from the
 * legacy model, where questions lived only as anonymous entries in an exam's
 * JSONB array. As a first-class entity a question can be owned, tagged,
 * searched, versioned, reused across many exams, and analysed per-question.
 *
 * `content` (what the student sees) and `answer_key` (the correct answer +
 * grading params) are separate JSONB payloads so the student-facing render can
 * never accidentally leak the answer — the attempt engine only ever serialises
 * `content`.
 */
@Entity('questions')
export class Question {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'teacher_id' })
  @Index('IDX_questions_teacher_id')
  teacher_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'teacher_id' })
  teacher!: User;

  @Column({ type: 'uuid', name: 'subject_id' })
  @Index('IDX_questions_subject_id')
  subject_id!: string;

  @ManyToOne(() => Subject)
  @JoinColumn({ name: 'subject_id' })
  subject!: Subject;

  /** Optional linkage to a lesson for taxonomy + per-lesson analytics. */
  @Column({ type: 'uuid', nullable: true, name: 'lesson_id' })
  @Index('IDX_questions_lesson_id')
  lesson_id!: string | null;

  @ManyToOne(() => Lesson, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Relation<Lesson> | null;

  /** Free-text curriculum taxonomy (no dedicated entities yet). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  chapter!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  topic!: string | null;

  @Column({ type: 'enum', enum: QuestionType })
  @Index('IDX_questions_type')
  type!: QuestionType;

  @Column({ type: 'enum', enum: Difficulty, nullable: true })
  @Index('IDX_questions_difficulty')
  difficulty!: Difficulty | null;

  @Column({ type: 'enum', enum: BloomLevel, nullable: true, name: 'bloom_level' })
  bloom_level!: BloomLevel | null;

  /** Presentation payload (prompt, options, media refs). Never contains answers. */
  @Column({ type: 'jsonb' })
  content!: QuestionContent;

  /** Correct answer + grading params. Excluded from all student-facing payloads. */
  @Column({ type: 'jsonb', name: 'answer_key' })
  answer_key!: QuestionAnswerKey;

  /** Default marks when this question is added to an exam (overridable per exam). */
  @Column({ type: 'int', name: 'default_marks', default: 1 })
  default_marks!: number;

  /** Simple free-tagging for search (dedicated tag tables are a later phase). */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  tags!: string[];

  /** Latest version number; incremented on every content/answer edit. */
  @Column({ type: 'int', name: 'current_version', default: 1 })
  current_version!: number;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  is_active!: boolean;

  @OneToMany('QuestionVersion', 'question')
  versions!: Relation<QuestionVersion[]>;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  @Index('IDX_questions_deleted_at')
  deleted_at!: Date | null;
}
