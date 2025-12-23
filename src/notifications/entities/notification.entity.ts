import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { NotificationType } from './notification-type.enum';

@Entity('notifications')
@Index('IDX_notifications_user_id', ['user_id'])
@Index('IDX_notifications_is_read', ['is_read'])
@Index('IDX_notifications_type', ['type'])
@Index('IDX_notifications_sent_at', ['sent_at'])
@Index('IDX_notifications_user_read', ['user_id', 'is_read'])
export class Notification {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int', name: 'user_id' })
  user_id!: number;

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

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;
}
