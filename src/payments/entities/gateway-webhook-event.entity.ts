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

  @Column({ type: 'timestamptz', nullable: true, name: 'processed_at' })
  processed_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
