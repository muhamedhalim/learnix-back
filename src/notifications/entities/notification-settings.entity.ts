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

  @Column({ type: 'boolean', default: true, name: 'sms_enabled' })
  sms_enabled!: boolean;

  @Column({ type: 'boolean', default: false, name: 'email_enabled' })
  email_enabled!: boolean;

  @Column({ type: 'boolean', default: false, name: 'push_enabled' })
  push_enabled!: boolean;

  // `parent_phone_override` removed. Guardian phone numbers are managed through
  // the guardian domain, where changing a verified number requires a fresh OTP.
  // An override column here was a hole in exactly that rule.

  @Column({
    type: 'boolean',
    default: true,
    name: 'notify_parent_on_attendance',
  })
  notify_parent_on_attendance!: boolean;

  @Column({
    type: 'boolean',
    default: true,
    name: 'notify_parent_on_exam_grade',
  })
  notify_parent_on_exam_grade!: boolean;

  @Column({
    type: 'boolean',
    default: true,
    name: 'notify_parent_on_lesson_expiry',
  })
  notify_parent_on_lesson_expiry!: boolean;

  @Column({ type: 'boolean', default: true, name: 'notify_on_purchase' })
  notify_on_purchase!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
