import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

/**
 * The canonical source of truth for a user's CHANNEL preferences.
 *
 * Scope, stated precisely because DEF-005 existed entirely in the gap between
 * what this table looked like it controlled and what it actually controlled:
 *
 *  - This table answers "which transports may Learnix use for notifications
 *    concerning this user". Nothing else may answer that question — every
 *    sender goes through `NotificationChannelPolicyService`.
 *  - It does NOT answer "which guardian gets told about which event". That is
 *    per (student, guardian) and lives in
 *    `student_guardians.notification_preferences`, which the guardian pipeline
 *    and the /student/guardians UI already share. The four
 *    `notify_parent_on_*` columns that used to duplicate it here were a second,
 *    silently-ignored model; they were backfilled into the guardian links and
 *    dropped by migration 2079000000000.
 *
 * In-app delivery has no flag here on purpose: the `notifications` row is the
 * durable record, and a user who has switched every transport off must still be
 * able to open the app and see what happened.
 */
@Entity('notification_settings')
@Index('IDX_notification_settings_user', ['user_id'], { unique: true })
export class NotificationSettings {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', unique: true, name: 'user_id' })
  user_id!: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  /**
   * Governs the SMS transport. Today SMS is only ever addressed to a student's
   * verified guardians, and this flag has always gated that fan-out — see
   * `NotificationChannelPolicyService`, which is now the only reader.
   */
  @Column({ type: 'boolean', default: true, name: 'sms_enabled' })
  sms_enabled!: boolean;

  /**
   * Governs OPTIONAL notification email. Transactional and security mail
   * (password reset, login verification, invoices, operational alerts) does not
   * consult this and must never be routed through the notification policy.
   */
  @Column({ type: 'boolean', default: false, name: 'email_enabled' })
  email_enabled!: boolean;

  /**
   * Governs push. Default `false` is a consent property, not an oversight: a
   * push registration requires an explicit browser permission grant, so the
   * server must not behave as though one exists until the client says so.
   */
  @Column({ type: 'boolean', default: false, name: 'push_enabled' })
  push_enabled!: boolean;

  // `parent_phone_override` removed. Guardian phone numbers are managed through
  // the guardian domain, where changing a verified number requires a fresh OTP.
  // An override column here was a hole in exactly that rule.
  //
  // `notify_parent_on_attendance` / `notify_parent_on_exam_grade` /
  // `notify_parent_on_lesson_expiry` / `notify_on_purchase` removed by
  // migration 2079000000000: they duplicated
  // `student_guardians.notification_preferences`, which is what the guardian
  // dispatcher actually reads, and no dispatcher ever read these. Values were
  // reconciled into the guardian links before the columns were dropped.

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
