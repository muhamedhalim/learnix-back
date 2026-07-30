import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Durable record of a call to a payment provider to dispatch a refund.
 *
 * A row is claimed before a provider request is made.  It is deliberately a
 * first-class table (rather than refund metadata) because recovery workers
 * need to lock, lease, and audit these calls after a process crash.
 */
@Entity('refund_attempts')
@Index('UQ_refund_attempt_refund_number', ['refund_id', 'attempt_number'], {
  unique: true,
})
@Index('UQ_refund_attempt_idempotency_key', ['idempotency_key'], { unique: true })
@Index('IDX_refund_attempt_status_retry', ['status', 'next_retry_at'])
@Index('IDX_refund_attempt_refund_status', ['refund_id', 'status'])
export class RefundAttempt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'refund_id' })
  refund_id!: string;

  @Column({ type: 'integer', name: 'attempt_number' })
  attempt_number!: number;

  @Column({ type: 'varchar', length: 180, name: 'idempotency_key' })
  idempotency_key!: string;

  @Column({ type: 'varchar', length: 40 })
  status!: string;

  @Column({ type: 'varchar', length: 180, nullable: true, name: 'provider_request_reference' })
  provider_request_reference!: string | null;

  @Column({ type: 'varchar', length: 180, nullable: true, name: 'provider_refund_id' })
  provider_refund_id!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true, name: 'claimed_by' })
  claimed_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'claimed_at' })
  claimed_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'lease_expires_at' })
  lease_expires_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'started_at' })
  started_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completed_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'next_retry_at' })
  next_retry_at!: Date | null;

  @Column({ type: 'integer', default: 0, name: 'attempt_count' })
  attempt_count!: number;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  last_error!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
