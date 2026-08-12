import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { Notification } from './notification.entity';
import { NotificationCampaignStatus } from './notification-campaign-status.enum';
import { NotificationOrigin } from './notification-origin.enum';

export interface NotificationCampaignAudience {
  kind: 'all_active_students' | 'user_ids';
  user_ids?: string[];
}

@Entity('notification_campaigns')
@Index('UQ_notification_campaigns_idempotency_key', ['idempotency_key'], { unique: true })
@Index('IDX_notification_campaigns_status_created', ['status', 'created_at'])
@Index('IDX_notification_campaigns_creator', ['created_by_user_id'])
export class NotificationCampaign {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 180, name: 'idempotency_key' })
  idempotency_key!: string;

  @Column({ type: 'uuid', nullable: true, name: 'created_by_user_id' })
  created_by_user_id!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by_user_id' })
  created_by!: User | null;

  @Column({ type: 'varchar', length: 32, default: NotificationOrigin.ADMIN_MANUAL })
  origin!: NotificationOrigin;

  @Column({ type: 'varchar', length: 32, default: NotificationCampaignStatus.QUEUED })
  status!: NotificationCampaignStatus;

  @Column({ type: 'varchar', length: 200, name: 'title_en' })
  title_en!: string;

  @Column({ type: 'text', name: 'message_en' })
  message_en!: string;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'title_ar' })
  title_ar!: string | null;

  @Column({ type: 'text', nullable: true, name: 'message_ar' })
  message_ar!: string | null;

  @Column({ type: 'jsonb' })
  audience!: NotificationCampaignAudience;

  @Column({ type: 'jsonb', name: 'requested_channels', default: () => "'[\"in_app\",\"push\"]'::jsonb" })
  requested_channels!: string[];

  @Column({ type: 'int', default: 0, name: 'intended_count' })
  intended_count!: number;

  @Column({ type: 'int', default: 0, name: 'created_count' })
  created_count!: number;

  @Column({ type: 'int', default: 0, name: 'failed_count' })
  failed_count!: number;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  error_message!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'queued_at' })
  queued_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'started_at' })
  started_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completed_at!: Date | null;

  @OneToMany(() => Notification, (notification) => notification.campaign)
  notifications!: Notification[];

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
