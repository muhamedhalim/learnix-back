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

import { User } from '../../users/entities/user.entity';
import { Lesson } from './lesson.entity';

@Entity('lesson_progress')
@Unique('UQ_lesson_progress_student_lesson', ['student_id', 'lesson_id'])
@Index('IDX_lesson_progress_student_id', ['student_id'])
@Index('IDX_lesson_progress_completed', ['completed'])
export class LessonProgress {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: Relation<User>;

  @Column({ type: 'uuid', name: 'lesson_id' })
  lesson_id!: string;

  @ManyToOne(() => Lesson, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Relation<Lesson>;

  @Column({ type: 'int', default: 0, name: 'watched_duration' })
  watched_duration!: number; // Total time watched in seconds

  @Column({ type: 'int', name: 'total_duration' })
  total_duration!: number; // Lesson duration in seconds

  @Column({ type: 'int', default: 0, name: 'progress_percent' })
  progress_percent!: number; // 0-100

  @Column({ type: 'boolean', default: false })
  completed!: boolean;

  /**
   * When the lesson first crossed into `completed`, set once and never moved.
   *
   * `updated_at` cannot answer "what did this student finish last week?":
   * `ProgressService.updateProgress` rewrites the row on every progress ping,
   * so re-watching a lesson finished months ago would drag it into the current
   * period. This column pins the completion to the moment it actually happened.
   *
   * Null for rows completed before the column existed — that history is not
   * recoverable, and guessing it would be worse than reporting nothing.
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  @Index('IDX_lesson_progress_completed_at', { where: '"completed_at" IS NOT NULL' })
  completed_at!: Date | null;

  @Column({ type: 'timestamp', name: 'last_watched_at' })
  last_watched_at!: Date;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
