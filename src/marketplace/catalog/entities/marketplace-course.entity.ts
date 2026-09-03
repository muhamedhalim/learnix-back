import {
  Check,
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

import type { Relation } from 'typeorm';

import { CourseLevel, MarketplaceCourseStatus } from '../../common/enums';
import { minorUnitsTransformer } from '../../../payments/money.util';
import { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';
import { MarketplaceCategory } from './marketplace-category.entity';
import type { MarketplaceCourseVersion } from './marketplace-course-version.entity';

/**
 * FR-041 – FR-075. Six lifecycle states, no seventh (data-model.md §2).
 * `total_duration_seconds` and `lesson_count` are **derived** from lessons —
 * never entered directly (FR-047).
 */
@Entity('marketplace_courses')
@Index('IDX_mp_courses_public', ['status', 'category_id', 'level', 'language'], {
  where: "\"status\" = 'published' AND \"removed_at\" IS NULL",
})
@Index('IDX_mp_courses_instructor_status', ['instructor_id', 'status'])
@Index('IDX_mp_courses_review_queue', ['status', 'updated_at'], {
  where: "\"status\" = 'submitted_for_review'",
})
@Index('IDX_mp_courses_price', ['currency', 'price_minor'])
@Index('UQ_mp_courses_slug', ['slug'], { unique: true })
@Check('CHK_mp_courses_price_nonneg', '"price_minor" >= 0')
@Check(
  'CHK_mp_courses_removed',
  "\"removed_at\" IS NULL OR (\"status\" = 'unpublished' AND \"removal_reason\" IS NOT NULL)",
)
export class MarketplaceCourse {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'instructor_id' })
  instructor_id!: string;

  @ManyToOne(() => MarketplaceInstructor, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'instructor_id' })
  instructor!: MarketplaceInstructor;

  @Column({ type: 'uuid', name: 'category_id' })
  category_id!: string;

  @ManyToOne(() => MarketplaceCategory, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category!: MarketplaceCategory;

  @Column({ type: 'varchar', length: 200 })
  slug!: string;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'title_ar' })
  title_ar!: string | null;

  @Column({ type: 'varchar', length: 500 })
  summary!: string;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'summary_ar' })
  summary_ar!: string | null;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'text', nullable: true, name: 'description_ar' })
  description_ar!: string | null;

  @Column({ type: 'varchar', length: 20 })
  level!: CourseLevel;

  @Column({ type: 'varchar', length: 10 })
  language!: string;

  @Column({ type: 'bigint', default: 0, name: 'price_minor', transformer: minorUnitsTransformer })
  price_minor!: number;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ type: 'varchar', length: 500, name: 'cover_image_key' })
  cover_image_key!: string;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'promo_video_id' })
  promo_video_id!: string | null;

  @Column({ type: 'text', array: true, default: () => "'{}'", name: 'learning_outcomes' })
  learning_outcomes!: string[];

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  prerequisites!: string[];

  @Column({ type: 'text', array: true, default: () => "'{}'", name: 'target_audience' })
  target_audience!: string[];

  @Column({ type: 'boolean', default: false, name: 'certificate_enabled' })
  certificate_enabled!: boolean;

  @Column({ type: 'varchar', length: 30, default: MarketplaceCourseStatus.DRAFT })
  status!: MarketplaceCourseStatus;

  @Column({ type: 'uuid', nullable: true, name: 'current_version_id' })
  current_version_id!: string | null;

  @ManyToOne('MarketplaceCourseVersion', { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'current_version_id' })
  current_version!: Relation<MarketplaceCourseVersion> | null;

  @Column({ type: 'int', default: 0, name: 'total_duration_seconds' })
  total_duration_seconds!: number;

  @Column({ type: 'int', default: 0, name: 'lesson_count' })
  lesson_count!: number;

  @Column({ type: 'timestamptz', nullable: true, name: 'first_published_at' })
  first_published_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_published_at' })
  last_published_at!: Date | null;

  /** FR-071: set when a material edit lands on a `published` course, awaiting a new review cycle; the live version stays what buyers see until this clears. Also the admin queue's waiting-time marker for these courses. */
  @Column({ type: 'timestamptz', nullable: true, name: 'pending_review_since' })
  pending_review_since!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'removed_at' })
  removed_at!: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'removed_by' })
  removed_by!: string | null;

  @Column({ type: 'text', nullable: true, name: 'removal_reason' })
  removal_reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deleted_at!: Date | null;
}
