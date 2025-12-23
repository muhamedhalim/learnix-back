import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('student_profiles')
export class StudentProfile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int', unique: true, nullable: false, name: 'user_id' })
  @Index('IDX_student_profiles_user_id')
  user_id!: number;

  @OneToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({
    type: 'varchar',
    length: 20,
    nullable: false,
    name: 'parent_phone',
  })
  parent_phone!: string;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'grade_level' })
  grade_level!: string | null;

  @Column({
    type: 'jsonb',
    nullable: false,
    default: '{}',
    name: 'notification_settings',
  })
  notification_settings!: Record<string, boolean>;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at!: Date | null;

  // Relations will be added as we build more features:
  // - OneToMany with LessonPurchase
  // - OneToMany with ExamAttempt
  // - OneToMany with Attendance
}
