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

import { Lesson } from './lesson.entity';
import type { HomeworkSubmission } from './homework-submission.entity';

/**
 * Homework / assignment attached to a lesson.
 *
 * `type` is kept as a string (not a hard enum) so new assignment kinds can be
 * added in future without a migration: 'text' | 'file' | 'link' | 'quiz' | …
 */
@Entity('lesson_homework')
@Index('IDX_lesson_homework_lesson_id', ['lesson_id'])
@Index('IDX_lesson_homework_lesson_published_due', ['lesson_id', 'published_at', 'due_at'], {
  where: '"deleted_at" IS NULL',
})
export class LessonHomework {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  lesson_id!: string;

  @ManyToOne(() => Lesson, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Lesson;

  @Column({ length: 255 })
  title!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title_ar!: string | null;

  @Column('text', { nullable: true })
  description!: string | null;

  @Column('text', { nullable: true })
  description_ar!: string | null;

  @Column({ length: 30, default: 'text' })
  type!: string;

  /** Optional reference (e.g. attachment URL for a file assignment). */
  @Column({ type: 'varchar', length: 1000, nullable: true })
  resource_url!: string | null;

  /** Original display name for the private assignment file; never a storage key. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  resource_filename!: string | null;

  @Column('timestamptz', { nullable: true })
  due_at!: Date | null;

  /** Structured prompts rendered to students; empty for a simple text/file task. */
  @Column('jsonb', { default: () => "'[]'::jsonb" })
  questions!: Array<{ id: string; prompt: string; prompt_ar?: string | null }>;

  @Column({ type: 'numeric', precision: 9, scale: 2, default: 100 })
  max_score!: number;

  /** Null while the assignment is a draft. Publishing fans out notifications. */
  @Column('timestamptz', { nullable: true })
  published_at!: Date | null;

  @OneToMany('HomeworkSubmission', 'homework')
  submissions!: HomeworkSubmission[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deleted_at!: Date | null;
}
