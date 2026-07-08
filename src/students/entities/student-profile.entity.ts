import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

@Entity('student_profiles')
export class StudentProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', unique: true, nullable: false, name: 'user_id' })
  @Index('IDX_student_profiles_user_id')
  user_id!: string;

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

  // Optional demographic fields used by the public gamification leaderboards
  // (Global / Governorate / School). Nullable + opt-in: geo/school boards only
  // rank students who filled these in — no forced backfill.
  @Column({ type: 'varchar', length: 100, nullable: true })
  @Index('IDX_student_profiles_country')
  country!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  @Index('IDX_student_profiles_governorate')
  governorate!: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  @Index('IDX_student_profiles_school')
  school!: string | null;

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
