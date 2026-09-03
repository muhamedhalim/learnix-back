import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { LessonContentType } from '../../common/enums';
import { MarketplaceCourseSection } from './marketplace-course-section.entity';

/**
 * An ordered unit of content within a section (data-model.md §2).
 * `duration_seconds` is a **displayed** attribute only — it never enters
 * progress or completion arithmetic (FR-240). `is_required_for_completion`
 * is the completion denominator (FR-242).
 */
@Entity('marketplace_course_lessons')
@Index('UQ_mp_lessons_section_position', ['section_id', 'position'], { unique: true })
@Index('IDX_mp_lessons_course_preview', ['section_id', 'is_free_preview'])
@Index('IDX_mp_lessons_required', ['section_id', 'is_required_for_completion'])
@Check('CHK_mp_lessons_duration_positive', '"duration_seconds" > 0')
export class MarketplaceCourseLesson {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'section_id' })
  section_id!: string;

  @ManyToOne(() => MarketplaceCourseSection, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'section_id' })
  section!: MarketplaceCourseSection;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'title_ar' })
  title_ar!: string | null;

  @Column({ type: 'int' })
  position!: number;

  @Column({ type: 'varchar', length: 20, name: 'content_type' })
  content_type!: LessonContentType;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'video_id' })
  video_id!: string | null;

  /** Sanitised on write (FR-304). */
  @Column({ type: 'text', nullable: true, name: 'content_html' })
  content_html!: string | null;

  @Column({ type: 'int', name: 'duration_seconds' })
  duration_seconds!: number;

  @Column({ type: 'boolean', default: false, name: 'is_free_preview' })
  is_free_preview!: boolean;

  @Column({ type: 'boolean', default: true, name: 'is_required_for_completion' })
  is_required_for_completion!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
