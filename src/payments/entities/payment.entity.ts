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

import { ItemType } from './item-type.enum';
import { PaymentMethod } from './payment-method.enum';
import { PaymentStatus } from './payment-status.enum';

@Entity('payments')
@Index('IDX_payments_user_id', ['user_id'])
@Index('IDX_payments_status', ['status'])
@Index('IDX_payments_item_type', ['item_type'])
@Index('IDX_payments_created_at', ['created_at'])
@Index('IDX_payments_user_status', ['user_id', 'status'])
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'enum', enum: ItemType, name: 'item_type' })
  item_type!: ItemType;

  @Column({ type: 'uuid', name: 'item_id' })
  item_id!: string;

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

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
