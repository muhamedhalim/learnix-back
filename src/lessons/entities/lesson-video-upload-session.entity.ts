import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Server-owned state for a direct Bunny TUS upload. Provider identifiers live
 * here rather than in browser-facing lesson responses. The record also acts as
 * the durable saga used to clean up abandoned uploads and replaced videos.
 */
@Entity('lesson_video_upload_sessions')
@Index('IDX_lesson_video_upload_sessions_cleanup', ['status', 'expires_at'])
@Index('IDX_lesson_video_upload_sessions_lesson', ['lesson_id', 'created_at'])
export class LessonVideoUploadSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'lesson_id' })
  lesson_id!: string;

  @Column({ type: 'uuid', name: 'teacher_id' })
  teacher_id!: string;

  /** Bunny-only identifier. Never return this in normal lesson APIs. */
  @Column({ type: 'varchar', length: 255, name: 'bunny_video_id' })
  bunny_video_id!: string;

  /** Video to delete only after the replacement is durably linked. */
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'previous_bunny_video_id' })
  previous_bunny_video_id!: string | null;

  @Column({ type: 'varchar', length: 24, default: 'created' })
  status!: 'created' | 'completed' | 'abandoned' | 'cleanup_pending' | 'cleaned';

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expires_at!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completed_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'cleaned_at' })
  cleaned_at!: Date | null;

  @Column({ type: 'int', default: 0, name: 'cleanup_attempts' })
  cleanup_attempts!: number;

  @Column({ type: 'text', nullable: true, name: 'last_cleanup_error' })
  last_cleanup_error!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
