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
  VersionColumn,
} from 'typeorm';

import type { LessonPurchase } from '../../payments/entities/lesson-purchase.entity';
import { Subject } from '../../subjects/entities/subject.entity';
import { User } from '../../users/entities/user.entity';
import { LessonStatus } from './lesson-status.enum';
import { ScheduledLessonSession } from './scheduled-lesson-session.entity';

@Entity('lessons')
@Index('IDX_lessons_active_created_id', ['created_at', 'id'], {
  where: '"deleted_at" IS NULL',
})
@Index('IDX_lessons_teacher_active_created_id', ['teacher_id', 'created_at', 'id'], {
  where: '"deleted_at" IS NULL',
})
@Index('IDX_lessons_subject_active_created_id', ['subject_id', 'created_at', 'id'], {
  where: '"deleted_at" IS NULL',
})
export class Lesson {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  @Index('IDX_lessons_title')
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'uuid', nullable: false, name: 'teacher_id' })
  @Index('IDX_lessons_teacher_id')
  teacher_id!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'teacher_id' })
  teacher!: User;

  @Column({ type: 'uuid', nullable: false, name: 'subject_id' })
  @Index('IDX_lessons_subject_id')
  subject_id!: string;

  @ManyToOne(() => Subject)
  @JoinColumn({ name: 'subject_id' })
  subject!: Subject;

  // Cover image: an uploaded custom image, or a copy of `video_thumbnail`
  // (the transcoder's poster) that the teacher chose to use as the
  // cover. Set via the course-builder's upload widget — never a raw
  // teacher-typed URL (that field was removed from the quick-create form).
  @Column({ type: 'varchar', length: 500, nullable: true })
  thumbnail!: string | null;

  /** AWS-hosted video (see `video_assets`: S3 source, MediaConvert HLS, CloudFront signed cookies). Null for video-less lessons. */
  @Column({ type: 'uuid', nullable: true, name: 'video_asset_id' })
  video_asset_id!: string | null;

  /**
   * Transcoding lifecycle of the lesson's video: 'processing' | 'ready' | 'failed'.
   * Null when the lesson has no video.
   */
  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
    name: 'video_status',
  })
  video_status!: string | null;

  /** Source video width in pixels, set when transcoding completes. */
  @Column({ type: 'int', nullable: true, name: 'video_width' })
  video_width!: number | null;

  /** Source video height in pixels, set when transcoding completes. */
  @Column({ type: 'int', nullable: true, name: 'video_height' })
  video_height!: number | null;

  /** Public URL of the poster generated for the video. */
  @Column({
    type: 'varchar',
    length: 500,
    nullable: true,
    name: 'video_thumbnail',
  })
  video_thumbnail!: string | null;

  /** Stored video size in bytes, set when transcoding completes. */
  @Column({ type: 'bigint', nullable: true, name: 'video_size_bytes' })
  video_size_bytes!: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false })
  price!: number;

  @Column({ type: 'int', nullable: true })
  duration!: number | null; // Duration in seconds

  @Column({ type: 'boolean', default: false, name: 'is_group' })
  is_group!: boolean;

  @Column({ type: 'int', default: 7, name: 'available_for_days' })
  available_for_days!: number;

  /**
   * @deprecated Denormalised purchase counter, still written by
   * `PaymentFinalizationService` (increment) and `RefundsService.revokeAccess`
   * (decrement on full refund only) but no longer read by any API.
   *
   * It counts settled *orders*, not students — a repeat buyer increments it
   * twice — it has no backfill for purchases predating the migration that added
   * it, and nothing reconciles the increment/decrement pair, so it drifts.
   * Every surface now derives the student count live from `lesson_purchases`;
   * see `LESSON_STUDENT_COUNT_SQL` in `LessonsService` and
   * `LearningMetricsService`. Left in place so the writes stay harmless and the
   * column-level schema is untouched; do not read it.
   */
  @Column({ type: 'int', default: 0, name: 'students_count' })
  students_count!: number;

  /**
   * When true, this lesson is playable on the public course preview without a
   * purchase (a free teaser). Locked lessons appear in the curriculum but expose
   * no playable video source.
   */
  @Column({ type: 'boolean', default: false, name: 'is_free_preview' })
  is_free_preview!: boolean;

  // Publishing state within a course (additive; existing lessons → published).
  @Column({
    type: 'enum',
    enum: LessonStatus,
    default: LessonStatus.DRAFT,
    name: 'status',
  })
  @Index('IDX_lessons_status')
  status!: LessonStatus;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;

  /** Incremented on every write so clients can detect stale editor state. */
  @VersionColumn({ name: 'version' })
  version!: number;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at!: Date | null;

  // Phase 4: Payment relations
  @OneToMany('LessonPurchase', 'lesson')
  purchases!: Relation<LessonPurchase[]>;

  @OneToMany(() => ScheduledLessonSession, (session) => session.lesson)
  scheduled_sessions!: Relation<ScheduledLessonSession[]>;
}
