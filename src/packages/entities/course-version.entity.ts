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

import type { LessonPackage } from './lesson-package.entity';

/**
 * An immutable-once-sold snapshot boundary for a course's curriculum.
 * `locked_at === null` means the version is still a mutable draft — its
 * content lives in the live `LessonPackageItem` rows, not here. The instant
 * it is first purchased, it is locked and its content is frozen forever into
 * `CourseVersionItem`; a DB trigger (see the AddCourseVersioning migration)
 * rejects any further mutation of that version's items, and of `locked_at`
 * itself once set.
 */
@Entity('course_versions')
@Index('IDX_course_versions_package_id', ['package_id'])
@Unique('UQ_course_versions_package_version', ['package_id', 'version_number'])
export class CourseVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  package_id!: string;

  @ManyToOne('LessonPackage', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'package_id' })
  package!: Relation<LessonPackage>;

  @Column('int')
  version_number!: number;

  @Column({ type: 'timestamptz', nullable: true })
  locked_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
