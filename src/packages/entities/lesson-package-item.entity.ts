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

import { Lesson } from '../../lessons/entities/lesson.entity';
import type { LessonPackage } from './lesson-package.entity';

@Entity('lesson_package_items')
@Index('IDX_lesson_package_items_package_id', ['package_id'])
@Index('IDX_lesson_package_items_lesson_id', ['lesson_id'])
@Unique('UQ_lesson_package_items_package_lesson', ['package_id', 'lesson_id'])
export class LessonPackageItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  package_id!: string;

  @ManyToOne('LessonPackage', 'items', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'package_id' })
  package!: Relation<LessonPackage>;

  @Column('uuid')
  lesson_id!: string;

  @ManyToOne(() => Lesson, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Lesson;

  @Column('int', { default: 0 })
  order_index!: number;

  /**
   * Optional chapter this lesson belongs to within the course.
   * Null = top-level (flat curriculum / Option B).
   */
  @Column('uuid', { nullable: true })
  @Index('IDX_lesson_package_items_chapter_id')
  chapter_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
