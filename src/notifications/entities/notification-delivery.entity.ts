import type { Relation } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Notification } from './notification.entity';
import { NotificationChannel } from './notification-channel.enum';
import { NotificationDeliveryStatus } from './notification-delivery-status.enum';
import { PushDevice } from './push-device.entity';

/**
 * The per-channel delivery leg of an existing `notifications` row.
 *
 * This is deliberately a CHILD of the notification the user already sees in
 * their history, not a parallel tracking system: one in-app notification fans
 * out to zero or more legs (one per channel, and for push one per device), and
 * the admin notification surface can join straight through `notification_id`.
 *
 * `dedupe_key` = `<notification_id>:<channel>:<device_id | '-'>`, UNIQUE. It is
 * what makes a BullMQ retry idempotent: the worker claims the row *before*
 * calling any provider, and a row that already reached a terminal status
 * refuses the claim. A student with three handsets therefore cannot receive six
 * pushes because the job ran twice, and a retry that follows two successes and
 * one dead token re-attempts nothing that already succeeded.
 */
@Entity('notification_deliveries')
@Index('IDX_notification_deliveries_notification', ['notification_id'])
@Index('IDX_notification_deliveries_status', ['status'])
@Index('IDX_notification_deliveries_channel', ['channel'])
@Index('UQ_notification_deliveries_dedupe_key', ['dedupe_key'], { unique: true })
export class NotificationDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 200, name: 'dedupe_key' })
  dedupe_key!: string;

  @Column({ type: 'uuid', name: 'notification_id' })
  notification_id!: string;

  @ManyToOne(() => Notification, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'notification_id' })
  notification!: Relation<Notification>;

  @Column({ type: 'enum', enum: NotificationChannel })
  channel!: NotificationChannel;

  @Column({
    type: 'enum',
    enum: NotificationDeliveryStatus,
    default: NotificationDeliveryStatus.QUEUED,
  })
  status!: NotificationDeliveryStatus;

  /** Transport provider actually used, e.g. `fcm`, `ses`, `twilio`. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  provider!: string | null;

  /**
   * Push only. `SET NULL` rather than `CASCADE`: deleting a stale device must
   * not erase the record that a notification was once accepted for it.
   */
  @Column({ type: 'uuid', nullable: true, name: 'push_device_id' })
  push_device_id!: string | null;

  @ManyToOne(() => PushDevice, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'push_device_id' })
  push_device!: PushDevice | null;

  /** Provider-assigned id (FCM `projects/…/messages/…`). Correlation handle. */
  @Column({ type: 'varchar', length: 300, nullable: true, name: 'provider_message_id' })
  provider_message_id!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  error_message!: string | null;

  /** Internal replay payload. Never serialize this field through admin APIs. */
  @Column({ type: 'jsonb', nullable: true, name: 'request_payload' })
  request_payload!: Record<string, unknown> | null;

  /** When the provider accepted it. Never set on a skip or a failure. */
  @Column({ type: 'timestamptz', nullable: true, name: 'sent_at' })
  sent_at!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
