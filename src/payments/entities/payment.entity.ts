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

import { User } from '../../users/entities/user.entity';
import { minorUnitsTransformer } from '../money.util';
import { ItemType } from './item-type.enum';
import { PaymentChannel } from './payment-channel.enum';
import { PaymentMethod } from './payment-method.enum';
import { PaymentStatus } from './payment-status.enum';

@Entity('payments')
@Index('IDX_payments_user_id', ['user_id'])
@Index('IDX_payments_status', ['status'])
@Index('IDX_payments_item_type', ['item_type'])
@Index('IDX_payments_created_at', ['created_at'])
@Index('IDX_payments_user_status', ['user_id', 'status'])
@Index('IDX_payments_reconciliation_retry', [
  'reconciliation_status',
  'reconciliation_next_retry_at',
])
@Index('UQ_payments_order_id', ['order_id'], { unique: true, where: '"order_id" IS NOT NULL' })
// Guarantees at most one in-flight (pending/processing) payment per user+item,
// so concurrent "Pay" clicks / refresh-during-payment cannot open two gateway
// orders for the same purchase (double-charge protection). Partial unique index.
@Index('UQ_payments_open_per_user_item', ['user_id', 'item_type', 'item_id'], {
  unique: true,
  where: "status IN ('pending', 'processing')",
})
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true, name: 'order_id' })
  order_id!: string | null;

  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  // Financial payment history must survive account archival/deletion attempts.
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  /** Null in the database only for the aggregate gateway payment owned by a CartCheckout. */
  @Column({ type: 'enum', enum: ItemType, nullable: true, name: 'item_type' })
  item_type!: ItemType;

  /** Null in the database only for the aggregate gateway payment owned by a CartCheckout. */
  @Column({ type: 'uuid', nullable: true, name: 'item_id' })
  item_id!: string;

  /** Links both the aggregate charge and allocated product payments to the cart checkout. */
  @Column({ type: 'uuid', nullable: true, name: 'cart_checkout_id' })
  cart_checkout_id!: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount!: number;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
    name: 'discount_amount',
  })
  discount_amount!: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'final_amount' })
  final_amount!: number;

  @Column({
    type: 'bigint',
    nullable: true,
    name: 'amount_minor',
    transformer: minorUnitsTransformer,
  })
  amount_minor!: number | null;

  @Column({ type: 'char', length: 3, default: 'EGP' })
  currency!: string;

  @Column({ type: 'varchar', length: 30, default: PaymentChannel.LEGACY })
  channel!: PaymentChannel;

  @Column({ type: 'varchar', length: 60, nullable: true })
  provider!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'provider_reference' })
  provider_reference!: string | null;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING,
  })
  status!: PaymentStatus;

  @Column({
    type: 'enum',
    enum: PaymentMethod,
    default: PaymentMethod.CARD,
    name: 'payment_method',
  })
  payment_method!: PaymentMethod;

  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
    name: 'paymob_order_id',
  })
  paymob_order_id!: string | null;

  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
    name: 'paymob_transaction_id',
  })
  paymob_transaction_id!: string | null;

  @Column({
    type: 'varchar',
    length: 255,
    unique: true,
    name: 'idempotency_key',
  })
  @Index('IDX_payments_idempotency_key', { unique: true })
  idempotency_key!: string;

  @Column({ type: 'text', nullable: true, name: 'failure_reason' })
  failure_reason!: string | null;

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

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completed_at!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
