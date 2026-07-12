import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Lesson } from './lesson.entity';

/**
 * Homework / assignment attached to a lesson.
 *
 * `type` is kept as a string (not a hard enum) so new assignment kinds can be
 * added in future without a migration: 'text' | 'file' | 'link' | 'quiz' | …
 */
@Entity('lesson_homework')
@Index('IDX_lesson_homework_lesson_id', ['lesson_id'])
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

  @Column('timestamptz', { nullable: true })
  due_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deleted_at!: Date | null;
}
