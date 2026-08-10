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
import { CartCheckoutStatus } from './cart-checkout-status.enum';
import { PaymentMethod } from './payment-method.enum';

/**
 * The single gateway charge for a cart.  Each product remains a normal Order
 * and receives its own allocated Payment only after the aggregate charge is
 * verified, which preserves per-product refunds and financial audit trails.
 */
@Entity('cart_checkouts')
@Index('UQ_cart_checkouts_number', ['checkout_number'], { unique: true })
@Index('UQ_cart_checkouts_idempotency', ['idempotency_key'], { unique: true })
@Index('IDX_cart_checkouts_student_status', ['student_id', 'status'])
@Index('IDX_cart_checkouts_expiry', ['status', 'expires_at'])
@Index('UQ_cart_checkouts_open_cart', ['student_id', 'cart_fingerprint'], {
  unique: true,
  where: "status IN ('awaiting_payment','payment_processing')",
})
export class CartCheckout {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 40, name: 'checkout_number' })
  checkout_number!: string;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  /** Cart is intentionally not FK-bound: it may be edited while payment is pending. */
  @Column({ type: 'uuid', name: 'cart_id' })
  cart_id!: string;

  @Column({ type: 'uuid', nullable: true, name: 'payment_id' })
  payment_id!: string | null;

  @Column({ type: 'varchar', length: 64, name: 'cart_fingerprint' })
  cart_fingerprint!: string;

  @Column({ type: 'bigint', name: 'original_amount_minor', transformer: minorUnitsTransformer })
  original_amount_minor!: number;

  @Column({ type: 'bigint', default: 0, name: 'discount_amount_minor', transformer: minorUnitsTransformer })
  discount_amount_minor!: number;

  @Column({ type: 'bigint', name: 'final_amount_minor', transformer: minorUnitsTransformer })
  final_amount_minor!: number;

  @Column({ type: 'char', length: 3, default: 'EGP' })
  currency!: string;

  @Column({ type: 'varchar', length: 40, default: CartCheckoutStatus.AWAITING_PAYMENT })
  status!: CartCheckoutStatus;

  @Column({ type: 'varchar', length: 30, name: 'payment_method' })
  payment_method!: PaymentMethod;

  @Column({ type: 'uuid', nullable: true, name: 'discount_code_id' })
  discount_code_id!: string | null;

  @Column({ type: 'jsonb', name: 'cart_snapshot' })
  cart_snapshot!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 255, name: 'idempotency_key' })
  idempotency_key!: string;

  @Column({ type: 'text', nullable: true, name: 'failure_reason' })
  failure_reason!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'expires_at' })
  expires_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'paid_at' })
  paid_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'cancelled_at' })
  cancelled_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
