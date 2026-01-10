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

export type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';

@Entity('attendance_records')
@Index('IDX_attendance_student_lesson', ['student_id', 'lesson_id'], {
  unique: true,
})
export class AttendanceRecord {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int', nullable: false, name: 'student_id' })
  @Index('IDX_attendance_student_id')
  student_id!: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'int', nullable: false, name: 'lesson_id' })
  @Index('IDX_attendance_lesson_id')
  lesson_id!: number;

  @ManyToOne(() => Lesson)
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Lesson;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'present',
  })
  @Index('IDX_attendance_status')
  status!: AttendanceStatus;

  @Column({ type: 'int', nullable: true, name: 'marked_by' })
  marked_by!: number | null;

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
