import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { AdminNotificationCategory } from './admin-notification-category.enum';
import { NotificationCampaign } from './notification-campaign.entity';
import { NotificationDelivery } from './notification-delivery.entity';
import { NotificationOrigin } from './notification-origin.enum';
import { NotificationPriority } from './notification-priority.enum';
import { NotificationStatus } from './notification-status.enum';
import { NotificationType } from './notification-type.enum';

@Entity('notifications')
@Index('IDX_notifications_user_id', ['user_id'])
@Index('IDX_notifications_is_read', ['is_read'])
@Index('IDX_notifications_type', ['type'])
@Index('IDX_notifications_sent_at', ['sent_at'])
@Index('IDX_notifications_user_read', ['user_id', 'is_read'])
@Index('IDX_notifications_campaign_user', ['campaign_id', 'user_id'], {
  unique: true,
  where: '"campaign_id" IS NOT NULL',
})
@Index('IDX_notifications_origin_sent', ['origin', 'sent_at'])
@Index('IDX_notifications_user_priority', ['user_id', 'priority'])
@Index('UQ_notifications_dedupe_key', ['dedupe_key'], {
  unique: true,
  where: '"dedupe_key" IS NOT NULL',
})
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 180, nullable: true, name: 'dedupe_key' })
  dedupe_key!: string | null;

  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @Column({ type: 'uuid', nullable: true, name: 'campaign_id' })
  campaign_id!: string | null;

  @ManyToOne(() => NotificationCampaign, (campaign) => campaign.notifications, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'campaign_id' })
  campaign!: NotificationCampaign | null;

  @Column({ type: 'uuid', nullable: true, name: 'created_by_user_id' })
  created_by_user_id!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by_user_id' })
  created_by!: User | null;

  @Column({ type: 'varchar', length: 32, default: NotificationOrigin.LEGACY_UNKNOWN })
  origin!: NotificationOrigin;

  @Column({ type: 'varchar', length: 120, nullable: true, name: 'source_event' })
  source_event!: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'enum', enum: NotificationType })
  type!: NotificationType;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'jsonb', nullable: true })
  data!: Record<string, unknown> | null;

  /**
   * Populated only for admin-facing notifications (see
   * `AdminNotificationEvent` / `ADMIN_NOTIFICATION_CATALOG`) — every other
   * notification leaves this `null`.
   */
  @Column({ type: 'varchar', length: 16, nullable: true })
  priority!: NotificationPriority | null;

  /** Same population rule as `priority`: admin notifications only. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  category!: AdminNotificationCategory | null;

  /** Deep link to where the recipient takes action, if any. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  link!: string | null;

  @Column({ type: 'boolean', default: false, name: 'is_read' })
  is_read!: boolean;

  @Column({ type: 'timestamptz', name: 'sent_at' })
  sent_at!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'read_at' })
  read_at!: Date | null;

  @Column({ type: 'boolean', default: false, name: 'sms_sent' })
  sms_sent!: boolean;

  @Column({ type: 'varchar', length: 20, nullable: true, name: 'sms_to' })
  sms_to!: string | null;

  @Column({
    type: 'enum',
    enum: NotificationStatus,
    default: NotificationStatus.PENDING,
  })
  @Index('IDX_notifications_status')
  status!: NotificationStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  error_message!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'delivered_at' })
  delivered_at!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @OneToMany(() => NotificationDelivery, (delivery) => delivery.notification)
  deliveries!: NotificationDelivery[];
}
