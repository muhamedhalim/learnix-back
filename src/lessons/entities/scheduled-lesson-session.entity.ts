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
import { ScheduledLessonSessionStatus } from './scheduled-lesson-session-status.enum';

@Entity('scheduled_lesson_sessions')
@Index('IDX_scheduled_lesson_sessions_lesson_start', ['lesson_id', 'start_at'])
@Index('IDX_scheduled_lesson_sessions_teacher_start', ['teacher_id', 'start_at'])
@Index('IDX_scheduled_lesson_sessions_status_start', ['status', 'start_at'])
@Check('CHK_scheduled_lesson_sessions_time', '"end_at" > "start_at"')
@Check(
  'CHK_scheduled_lesson_sessions_https_meeting_url',
  '"meeting_url" IS NULL OR "meeting_url" ~* \'^https://\'',
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
