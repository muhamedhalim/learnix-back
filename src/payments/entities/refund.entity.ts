import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { minorUnitsTransformer } from '../money.util';
import { PaymentChannel } from './payment-channel.enum';
import { RefundStatus } from './refund-status.enum';

@Entity('refunds')
@Index('IDX_refunds_order_status', ['order_id', 'status'])
@Index('IDX_refunds_status_created', ['status', 'created_at'])
@Index('IDX_refunds_reconciliation_retry', [
  'reconciliation_status',
  'reconciliation_next_retry_at',
])
export class Refund {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'order_id' })
  order_id!: string;

  @Column({ type: 'uuid', nullable: true, name: 'payment_id' })
  payment_id!: string | null;

  @Column({ type: 'varchar', length: 30 })
  channel!: PaymentChannel;

  @Column({
    type: 'bigint',
    name: 'amount_minor',
    transformer: minorUnitsTransformer,
  })
  amount_minor!: number;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ type: 'varchar', length: 30, default: RefundStatus.REQUESTED })
  status!: RefundStatus;

  @Column({ type: 'varchar', length: 80, name: 'reason_code' })
  reason_code!: string;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'text', nullable: true, name: 'internal_note' })
  internal_note!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true, name: 'external_method' })
  external_method!: string | null;

  @Column({ type: 'varchar', length: 180, nullable: true, name: 'external_reference' })
  external_reference!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'proof_file_key' })
  proof_file_key!: string | null;

  @Column({ type: 'uuid', name: 'requested_by' })
  requested_by!: string;

  @Column({ type: 'uuid', nullable: true, name: 'approved_by' })
  approved_by!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'completed_by' })
  completed_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completed_at!: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 40, default: 'pending', name: 'reconciliation_status' })
  reconciliation_status!: string;

  @Column({ type: 'integer', default: 0, name: 'reconciliation_attempt_count' })
  reconciliation_attempt_count!: number;

  @Column({ type: 'timestamptz', nullable: true, name: 'reconciliation_last_attempted_at' })
  reconciliation_last_attempted_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'reconciliation_next_retry_at' })
  reconciliation_next_retry_at!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'reconciliation_last_provider_error' })
  reconciliation_last_provider_error!: string | null;

  @Column({ type: 'text', nullable: true, name: 'reconciliation_quarantine_reason' })
  reconciliation_quarantine_reason!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'reconciliation_quarantined_at' })
  reconciliation_quarantined_at!: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'reconciliation_claim_token' })
  reconciliation_claim_token!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'reconciliation_lease_expires_at' })
  reconciliation_lease_expires_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
