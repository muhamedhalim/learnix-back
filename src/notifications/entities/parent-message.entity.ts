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

import { ParentEventType } from '../../common/events/parent-event-type.enum';
import { Guardian } from '../../guardians/entities/guardian.entity';
import { User } from '../../users/entities/user.entity';
import { MessageChannel } from './message-channel.enum';
import { ParentMessageStatus } from './parent-message-status.enum';

/**
 * One message sent (or attempted) to one guardian about one event.
 *
 * `idempotency_key` is the linchpin of the whole pipeline. It is UNIQUE, and
 * derived deterministically from (event type, the subject of the event,
 * guardian). The worker inserts the row *before* calling any provider, so:
 *
 *  - a BullMQ retry of a job that already sent finds the row and stops;
 *  - two concurrent workers race on the unique index, and exactly one wins;
 *  - re-marking attendance, or re-grading an attempt, cannot re-notify.
 *
 * Deduplication therefore lives in Postgres, not in application memory, and
 * survives a worker crash between "provider accepted" and "row updated".
 */
@Entity('parent_messages')
@Index('IDX_parent_messages_guardian', ['guardian_id'])
@Index('IDX_parent_messages_student', ['student_id'])
@Index('IDX_parent_messages_status', ['status'])
@Index('IDX_parent_messages_event_type', ['event_type'])
@Index('IDX_parent_messages_created_at', ['created_at'])
export class ParentMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** `<event_type>:<subject_id>:<guardian_id>` — UNIQUE. */
  @Column({ type: 'varchar', length: 200, unique: true, name: 'idempotency_key' })
  idempotency_key!: string;

  @Column({ type: 'uuid', name: 'guardian_id' })
  guardian_id!: string;

  @ManyToOne(() => Guardian, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'guardian_id' })
  guardian!: Guardian;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'enum', enum: ParentEventType, name: 'event_type' })
  event_type!: ParentEventType;

  @Column({ type: 'enum', enum: MessageChannel })
  channel!: MessageChannel;

  @Column({
    type: 'enum',
    enum: ParentMessageStatus,
    default: ParentMessageStatus.QUEUED,
  })
  status!: ParentMessageStatus;

  /** Template identifier actually rendered, e.g. `exam_graded.ar`. */
  @Column({ type: 'varchar', length: 100, name: 'template_key' })
  template_key!: string;

  /** Rendered body. Retained for the admin surface and for auditing what a parent saw. */
  @Column({ type: 'text' })
  body!: string;

  /**
   * The variables the template was rendered from. Never contains credentials;
   * OTP codes are excluded at the call site.
   */
  @Column({ type: 'jsonb', nullable: true })
  variables!: Record<string, unknown> | null;

  /** Provider-assigned id (Meta `wamid.*`, Twilio `SM…`), used to match webhooks. */
  @Column({ type: 'varchar', length: 200, nullable: true, name: 'provider_message_id' })
  @Index('IDX_parent_messages_provider_message_id')
  provider_message_id!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  error_message!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'sent_at' })
  sent_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'delivered_at' })
  delivered_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'read_at' })
  read_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'failed_at' })
  failed_at!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
