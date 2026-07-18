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

import type { PackagePurchase } from '../../payments/entities/package-purchase.entity';
import { Subject } from '../../subjects/entities/subject.entity';
import { User } from '../../users/entities/user.entity';
import { CourseStatus } from './course-status.enum';
import type { LessonPackageItem } from './lesson-package-item.entity';

@Entity('lesson_packages')
@Index('IDX_lesson_packages_teacher_id', ['teacher_id'])
@Index('IDX_lesson_packages_is_active', ['is_active'])
@Index('IDX_lesson_packages_price', ['price'])
@Index('IDX_lesson_packages_created_at', ['created_at'])
@Index('IDX_lesson_packages_status', ['status'])
@Index('IDX_lesson_packages_subject_id', ['subject_id'])
export class LessonPackage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 255 })
  title!: string;

  @Column({ length: 255 })
  title_ar!: string;

  @Column('text', { nullable: true })
  description!: string | null;

  @Column('text', { nullable: true })
  description_ar!: string | null;

  @Column('uuid')
  teacher_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'teacher_id' })
  teacher!: User;

  // Nullable: pre-existing packages predate this column (see migration
  // 1910000000000-AddSubjectToLessonPackages) and have no subject on record.
  // Every new/updated package requires one — enforced by CreatePackageDto/
  // UpdatePackageDto, not by the DB — so this is legacy-data-only nullability.
  @Column('uuid', { nullable: true })
  subject_id!: string | null;

  @ManyToOne(() => Subject, { nullable: true })
  @JoinColumn({ name: 'subject_id' })
  subject!: Relation<Subject> | null;

  @Column('decimal', { precision: 10, scale: 2 })
  price!: number;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  original_price!: number | null;

  @Column('boolean', { default: true })
  is_active!: boolean;

  @Column('varchar', { length: 500, nullable: true })
  thumbnail!: string | null;

  // ── Course CMS fields (additive) ───────────────────────────────────────────
  @Column({
    type: 'enum',
    enum: CourseStatus,
    default: CourseStatus.DRAFT,
  })
  status!: CourseStatus;

  @Column('boolean', { default: false })
  featured!: boolean;

  @Column('varchar', { length: 100, nullable: true })
  category!: string | null;

  /** Free-form tags (stored as a Postgres text[]). */
  @Column('text', { array: true, nullable: true })
  tags!: string[] | null;

  /** Teacher-estimated total duration in minutes. */
  @Column('int', { nullable: true })
  estimated_duration!: number | null;

  // ── Public preview fields (additive) ───────────────────────────────────────
  /** Prerequisites shown on the public course page. */
  @Column('text', { array: true, nullable: true })
  requirements!: string[] | null;

  /** "What you'll learn" bullet points. */
  @Column('text', { array: true, nullable: true, name: 'what_you_learn' })
  what_you_learn!: string[] | null;

  /** FAQ entries: `[{ question, answer }]`. */
  @Column('jsonb', { nullable: true })
  faq!: { question: string; answer: string }[] | null;

  /** Short intro/teaser video URL shown before purchase. */
  @Column('varchar', { length: 500, nullable: true, name: 'intro_video_url' })
  intro_video_url!: string | null;

  /** When the course was (last) published. */
  @Column('timestamptz', { nullable: true })
  published_at!: Date | null;

  /** When a draft course should auto-publish (scheduled publishing). */
  @Column('timestamptz', { nullable: true })
  @Index('IDX_lesson_packages_scheduled_publish_at')
  scheduled_publish_at!: Date | null;

  @OneToMany('LessonPackageItem', 'package', {
    cascade: true,
  })
  items!: Relation<LessonPackageItem[]>;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deleted_at!: Date | null;

  // Phase 4: Payment relations
  @OneToMany('PackagePurchase', 'package')
  purchases!: Relation<PackagePurchase[]>;
}
