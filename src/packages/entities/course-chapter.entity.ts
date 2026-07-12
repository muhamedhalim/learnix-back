import type { Relation } from 'typeorm';
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

import { LessonPackage } from './lesson-package.entity';

/**
 * Optional grouping of lessons inside a course (package).
 *
 * Chapters are optional: a course can have a flat lesson list (no chapters) or
 * group lessons under chapters. A lesson's chapter membership lives on
 * `LessonPackageItem.chapter_id` (nullable) so the same lesson can sit in
 * different chapters across different courses.
 */
@Entity('course_chapters')
@Index('IDX_course_chapters_package_id', ['package_id'])
export class CourseChapter {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  package_id!: string;

  @ManyToOne(() => LessonPackage, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'package_id' })
  package!: Relation<LessonPackage>;

  @Column({ length: 255 })
  title!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title_ar!: string | null;

  @Column('int', { default: 0 })
  order_index!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deleted_at!: Date | null;
}
