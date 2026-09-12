import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { PreferredLanguage } from '../../guardians/entities/preferred-language.enum';
import { UserRole } from './user-role.enum';
import { UserStatus } from './user-status.enum';
import type { FinancePermission } from '../../payments/finance-permissions';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true, nullable: false })
  @Index('IDX_users_username')
  username!: string;

  @Column({ type: 'varchar', nullable: false })
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  first_name!: string | null;

  @Column({ type: 'varchar', nullable: true })
  last_name!: string | null;

  @Column({ unique: true, nullable: false })
  @Index('IDX_users_email')
  email!: string;

  @Column({ type: 'varchar', nullable: true, select: false })
  password_hash!: string | null;

  @Column({ type: 'varchar', unique: true, nullable: false })
  @Index('IDX_users_phone')
  phone!: string;

  // `parent_phone` removed — a student's guardians now live in `guardians` /
  // `student_guardians` (see CreateGuardianSystem1800000000000).

  /**
   * Academic role, or NULL for a marketplace-only identity — an approved
   * instructor who never registered as a student or teacher.
   *
   * Every academic role check, list, report and analytics query is keyed on
   * this column, so NULL keeps such an account out of all of them by
   * construction rather than by remembering to filter: SQL comparisons never
   * match NULL and `RolesGuard` denies it. Instructor authority is not stored
   * here at all — it lives in `marketplace_instructors` (spec Clarifications
   * 2026-09-03: this field "MUST NOT gain a new value").
   *
   * The `student` default is retained so existing inserts that omit the column
   * behave exactly as before; only marketplace provisioning passes NULL.
   */
  @Column({
    type: 'enum',
    enum: UserRole,
    nullable: true,
    default: UserRole.STUDENT,
  })
  @Index('IDX_users_role')
  role!: UserRole | null;

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

  @Column({
    type: 'jsonb',
    name: 'finance_permissions',
    default: () => `'[]'::jsonb`,
  })
  finance_permissions!: FinancePermission[];

  // Rejection reason (only set when status = REJECTED)
  @Column({ type: 'text', nullable: true })
  rejection_reason!: string | null;

  /**
   * Preferred UI/content language. Nullable for backward compatibility — a
   * null value resolves to English via the localized-content fallback (see
   * i18n/localized-content.util). Reuses the same `PreferredLanguage` enum
   * that already drives guardian-message localization.
   */
  @Column({
    type: 'enum',
    enum: PreferredLanguage,
    nullable: true,
    name: 'preferred_language',
  })
  preferred_language!: PreferredLanguage | null;

  @Column({ type: 'varchar', nullable: true })
  profile_picture_url!: string | null;

  @Column({ type: 'varchar', nullable: true })
  profile_picture_thumbnail_url!: string | null;

  @Column({ type: 'varchar', unique: true, nullable: true })
  firebase_uid!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  last_login!: Date | null;

  // Password reset fields (mirrors the refresh-token storage strategy):
  //  - password_reset_token: bcrypt hash of the raw token (never stored in clear)
  //  - password_reset_token_id: SHA-256 of the raw token for O(1) indexed lookup
  //  - password_reset_expires_at: short-lived expiry; presence of a hash = single-use pending reset
  @Column({ type: 'text', nullable: true, select: false })
  password_reset_token!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  @Index('IDX_users_password_reset_token_id')
  password_reset_token_id!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  password_reset_expires_at!: Date | null;

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
