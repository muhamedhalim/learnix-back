import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('gateway_webhook_events')
@Index('UQ_gateway_webhook_provider_event', ['provider', 'provider_event_id'], {
  unique: true,
})
@Index('IDX_gateway_webhook_status_created', ['status', 'created_at'])
@Index('IDX_gateway_webhook_lease', ['status', 'next_retry_at', 'lease_expires_at'])
export class GatewayWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 60 })
  provider!: string;

  @Column({ type: 'varchar', length: 180, name: 'provider_event_id' })
  provider_event_id!: string;

  @Column({ type: 'uuid', nullable: true, name: 'payment_id' })
  payment_id!: string | null;

  @Column({ type: 'varchar', length: 30 })
  status!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  error_message!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'lease_token' })
  lease_token!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true, name: 'claimed_by' })
  claimed_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'claimed_at' })
  claimed_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'lease_expires_at' })
  lease_expires_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'heartbeat_at' })
  heartbeat_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'next_retry_at' })
  next_retry_at!: Date | null;

  @Column({ type: 'integer', default: 0, name: 'attempt_count' })
  attempt_count!: number;

  @Column({ type: 'integer', default: 8, name: 'max_attempts' })
  max_attempts!: number;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  last_error!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'processed_at' })
  processed_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
