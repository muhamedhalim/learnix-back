import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Lesson } from '../../lessons/entities/lesson.entity';

@Entity('lesson_sessions')
export class LessonSession {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'uuid', nullable: false, name: 'student_id' })
  @Index('IDX_lesson_sessions_student_id')
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'int', nullable: false, name: 'lesson_id' })
  @Index('IDX_lesson_sessions_lesson_id')
  lesson_id!: number;

  @ManyToOne(() => Lesson)
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Lesson;

  @CreateDateColumn({ name: 'entered_at' })
  entered_at!: Date;

  @Column({ type: 'timestamp', nullable: true, name: 'exited_at' })
  exited_at!: Date | null;

  @Column({ type: 'int', default: 0, name: 'duration_seconds' })
  duration_seconds!: number;

  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    default: 0,
    name: 'watch_percentage',
  })
  watch_percentage!: number;

  @Column({ type: 'boolean', default: false, name: 'is_completed' })
  @Index('IDX_lesson_sessions_completed')
  is_completed!: boolean;

  @Column({ type: 'varchar', length: 45, nullable: true, name: 'ip_address' })
  ip_address!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'device_info' })
  device_info!: string | null;
}
