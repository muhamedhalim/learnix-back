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

  // `parent_phone` removed — see `guardians` / `student_guardians`. It was
  // NOT NULL yet routinely held '' because registration made it optional.

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

  /** Public profiles and leaderboards are opt-in to protect student privacy. */
  @Column({ type: 'boolean', default: false, name: 'is_public_profile' })
  @Index('IDX_student_profiles_is_public_profile')
  is_public_profile!: boolean;

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
