import type { Relation } from 'typeorm';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { Lesson } from './lesson.entity';
import type { LessonSessionBooking } from './lesson-session-booking.entity';
import { MeetingCreationStatus } from './meeting-creation-status.enum';
import { MeetingProvider } from './meeting-provider.enum';
import { ScheduledLessonSessionStatus } from './scheduled-lesson-session-status.enum';
import type { TeacherMeetingAccount } from './teacher-meeting-account.entity';

@Entity('scheduled_lesson_sessions')
@Index('IDX_scheduled_lesson_sessions_lesson_start', ['lesson_id', 'start_at'])
@Index('IDX_scheduled_lesson_sessions_teacher_start', ['teacher_id', 'start_at'])
@Index('IDX_scheduled_lesson_sessions_status_start', ['status', 'start_at'])
@Index('IDX_scheduled_sessions_meeting_status', ['meeting_status'], {
  where: `"meeting_status" IN ('pending', 'creating', 'failed')`,
})
@Index('UQ_scheduled_sessions_external_meeting', ['meeting_provider', 'external_meeting_id'], {
  unique: true,
  where: '"external_meeting_id" IS NOT NULL',
})
@Check('CHK_scheduled_lesson_sessions_time', '"end_at" > "start_at"')
@Check(
  'CHK_scheduled_lesson_sessions_https_meeting_url',
  '"meeting_url" IS NULL OR "meeting_url" ~* \'^https://\'',
)
@Check(
  'CHK_scheduled_lesson_sessions_https_meeting_host_url',
  '"meeting_host_url" IS NULL OR "meeting_host_url" ~* \'^https://\'',
)
export class ScheduledLessonSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'lesson_id' })
  lesson_id!: string;

  @ManyToOne(() => Lesson, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Relation<Lesson>;

  @Column({ type: 'uuid', name: 'teacher_id' })
  teacher_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'teacher_id' })
  teacher!: Relation<User>;

  @Column({ type: 'timestamptz', name: 'start_at' })
  start_at!: Date;

  @Column({ type: 'timestamptz', name: 'end_at' })
  end_at!: Date;

  @Column({
    type: 'enum',
    enum: ScheduledLessonSessionStatus,
    default: ScheduledLessonSessionStatus.SCHEDULED,
  })
  status!: ScheduledLessonSessionStatus;

  @Column({ type: 'varchar', length: 2000, nullable: true, name: 'meeting_url' })
  meeting_url!: string | null;

  /**
   * Set by the teacher when creating/editing the appointment; acted on only by
   * the explicit Generate action (Phase 5), never automatically.
   */
  @Column({
    type: 'enum',
    enum: MeetingProvider,
    enumName: 'scheduled_lesson_sessions_meeting_provider_enum',
    nullable: true,
    name: 'meeting_provider',
  })
  meeting_provider!: MeetingProvider | null;

  @Column({
    type: 'enum',
    enum: MeetingCreationStatus,
    enumName: 'scheduled_lesson_sessions_meeting_status_enum',
    default: MeetingCreationStatus.NOT_REQUIRED,
    name: 'meeting_status',
  })
  meeting_status!: MeetingCreationStatus;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'external_meeting_id' })
  external_meeting_id!: string | null;

  /** Teacher-only start URL (e.g. Zoom `start_url`) — must never reach a student DTO. */
  @Column({ type: 'varchar', length: 2000, nullable: true, name: 'meeting_host_url' })
  meeting_host_url!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'meeting_passcode' })
  meeting_passcode!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'meeting_account_id' })
  meeting_account_id!: string | null;

  @ManyToOne('TeacherMeetingAccount', { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'meeting_account_id' })
  meeting_account!: Relation<TeacherMeetingAccount> | null;

  @Column({ type: 'text', nullable: true, name: 'meeting_error' })
  meeting_error!: string | null;

  @Column({ type: 'int', default: 0, name: 'meeting_attempts' })
  meeting_attempts!: number;

  @Column({ type: 'timestamptz', nullable: true, name: 'meeting_requested_at' })
  meeting_requested_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'meeting_ready_at' })
  meeting_ready_at!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'cancellation_reason' })
  cancellation_reason!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'cancellation_requested_at' })
  cancellation_requested_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'cancelled_at' })
  cancelled_at!: Date | null;

  @OneToMany('LessonSessionBooking', 'session')
  bookings!: Relation<LessonSessionBooking[]>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
