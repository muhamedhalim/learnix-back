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
import { ScheduledLessonSession } from '../../lessons/entities/scheduled-lesson-session.entity';
import { User } from '../../users/entities/user.entity';

export type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';

@Entity('attendance_records')
@Index('UQ_attendance_legacy_student_lesson', ['student_id', 'lesson_id'], {
  unique: true,
  where: '"scheduled_lesson_session_id" IS NULL',
})
@Index('UQ_attendance_student_scheduled_session', ['student_id', 'scheduled_lesson_session_id'], {
  unique: true,
  where: '"scheduled_lesson_session_id" IS NOT NULL',
})
export class AttendanceRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false, name: 'student_id' })
  @Index('IDX_attendance_student_id')
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'uuid', nullable: false, name: 'lesson_id' })
  @Index('IDX_attendance_lesson_id')
  lesson_id!: string;

  @ManyToOne(() => Lesson)
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Lesson;

  @Column({ type: 'uuid', nullable: true, name: 'scheduled_lesson_session_id' })
  scheduled_lesson_session_id!: string | null;

  @ManyToOne(() => ScheduledLessonSession, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'scheduled_lesson_session_id' })
  scheduled_lesson_session!: ScheduledLessonSession | null;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'present',
  })
  @Index('IDX_attendance_status')
  status!: AttendanceStatus;

  @Column({ type: 'uuid', nullable: true, name: 'marked_by' })
  marked_by!: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'marked_by' })
  marker!: User | null;

  @Column({ type: 'boolean', default: false, name: 'is_auto_marked' })
  is_auto_marked!: boolean;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: 'marked_at' })
  @Index('IDX_attendance_marked_at')
  marked_at!: Date;
}
