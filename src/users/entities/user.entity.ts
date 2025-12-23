import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';
import { UserRole } from './user-role.enum';
import { UserStatus } from './user-status.enum';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true, nullable: false })
  @Index('IDX_users_username')
  username!: string;

  @Column({ unique: true, nullable: false })
  @Index('IDX_users_email')
  email!: string;

  @Column({ type: 'varchar', nullable: true, select: false })
  password_hash!: string | null;

  @Column({ type: 'varchar', nullable: true })
  first_name!: string | null;

  @Column({ type: 'varchar', nullable: true })
  last_name!: string | null;

  @Column({ type: 'varchar', nullable: true })
  phone!: string | null;

  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.STUDENT,
  })
  @Index('IDX_users_role')
  role!: UserRole;

  @Column({ default: true })
  is_active!: boolean;

  // Approval workflow status (PENDING for new teachers/students, APPROVED for admins)
  @Column({
    type: 'enum',
    enum: UserStatus,
    default: UserStatus.APPROVED, // Default APPROVED for backward compatibility
  })
  @Index('IDX_users_status')
  status!: UserStatus;

  // Rejection reason (only set when status = REJECTED)
  @Column({ type: 'text', nullable: true })
  rejection_reason!: string | null;

  @Column({ type: 'varchar', nullable: true })
  profile_picture_url!: string | null;

  @Column({ type: 'varchar', unique: true, nullable: true })
  firebase_uid!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  last_login!: Date | null;

  // JWT Refresh Token fields
  @Column({ type: 'text', nullable: true, select: false })
  refresh_token!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  @Index('IDX_users_refresh_token_id')
  refresh_token_id!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  refresh_token_expires_at!: Date | null;

  // Timestamps
  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @DeleteDateColumn()
  deleted_at!: Date | null;

  // Relations will be added as we create other modules:
  // - TeacherProfile (OneToOne, when role is TEACHER)
  // - StudentProfile (OneToOne, when role is STUDENT)
  // - LessonPurchases (OneToMany)
  // - ExamAttempts (OneToMany)
  // - etc.
}
