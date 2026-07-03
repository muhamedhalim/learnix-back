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

/**
 * Personal study note a viewer keeps on a lesson. One note per (user, lesson);
 * the Study UI autosaves it. Notes are private to their author.
 */
@Entity('lesson_notes')
@Unique('UQ_lesson_notes_user_lesson', ['user_id', 'lesson_id'])
@Index('IDX_lesson_notes_user_id', ['user_id'])
@Index('IDX_lesson_notes_lesson_id', ['lesson_id'])
export class LessonNote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'uuid', name: 'lesson_id' })
  lesson_id!: string;

  @ManyToOne(() => Lesson, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Lesson;

  @Column({ type: 'text', default: '' })
  content!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
