import { Lesson } from '../../lessons/entities/lesson.entity';
import { User } from '../../users/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('lesson_sessions')
@Index('IDX_lesson_sessions_student_lesson_entered', [
  'student_id',
  'lesson_id',
  'entered_at',
])
export class LessonSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false, name: 'student_id' })
  @Index('IDX_lesson_sessions_student_id')
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'uuid', nullable: false, name: 'lesson_id' })
  @Index('IDX_lesson_sessions_lesson_id')
  lesson_id!: string;

  @ManyToOne(() => Lesson)
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Lesson;

  @CreateDateColumn({ name: 'entered_at' })
  entered_at!: Date;

  @Column({ type: 'timestamp', nullable: true, name: 'exited_at' })
  exited_at!: Date | null;

  @Column({ type: 'int', default: 0, name: 'duration_seconds' })
  duration_seconds!: number;

  @Column({ type: 'int', default: 0, name: 'video_progress_percent' })
  video_progress_percent!: number;

  @Column({ type: 'varchar', length: 45, nullable: true, name: 'ip_address' })
  ip_address!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'device_info' })
  device_info!: string | null;
}
