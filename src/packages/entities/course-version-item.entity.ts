import type { Relation } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Lesson } from '../../lessons/entities/lesson.entity';
import type { CourseVersion } from './course-version.entity';

/**
 * Frozen curriculum membership for one locked `CourseVersion`, copied once
 * from the live `LessonPackageItem` rows at the moment that version is first
 * purchased. Never updated or deleted afterward — enforced by a DB trigger,
 * not just service-layer discipline (see the AddCourseVersioning migration).
 *
 * `chapter_id` is informational only: chapter *names* are not versioned, so
 * a chapter rename can still bleed into a locked version's display if ever
 * surfaced. Only lesson membership (which drives entitlement, progress, and
 * certificate eligibility) is truly frozen.
 */
@Entity('course_version_items')
@Index('IDX_course_version_items_version_id', ['version_id'])
@Index('IDX_course_version_items_lesson_id', ['lesson_id'])
export class CourseVersionItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  version_id!: string;

  @ManyToOne('CourseVersion', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'version_id' })
  version!: Relation<CourseVersion>;

  @Column('uuid')
  lesson_id!: string;

  @ManyToOne(() => Lesson, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Lesson;

  @Column('int', { default: 0 })
  order_index!: number;

  @Column('uuid', { nullable: true })
  chapter_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
