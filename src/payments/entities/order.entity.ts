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
import { CollectionParty } from './collection-party.enum';
import { ItemType } from './item-type.enum';
import { OrderStatus } from './order-status.enum';
import { PaymentChannel } from './payment-channel.enum';

@Entity('orders')
@Index('UQ_orders_order_number', ['order_number'], { unique: true })
@Index('IDX_orders_student_status', ['student_id', 'status'])
@Index('IDX_orders_teacher_status', ['teacher_id', 'status'])
@Index('IDX_orders_item', ['item_type', 'item_id'])
@Index('IDX_orders_channel_created', ['payment_channel', 'created_at'])
@Index('UQ_orders_activation_code', ['activation_code_id'], {
  unique: true,
  where: '"activation_code_id" IS NOT NULL',
})
@Index('UQ_orders_active_student_item', ['student_id', 'item_type', 'item_id'], {
  unique: true,
  where: "status IN ('awaiting_payment','payment_submitted','under_review')",
})
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 40, name: 'order_number' })
  order_number!: string;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'uuid', nullable: true, name: 'teacher_id' })
  teacher_id!: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'teacher_id' })
  teacher!: User | null;

  @Column({ type: 'varchar', length: 30, name: 'item_type' })
  item_type!: ItemType;

  @Column({ type: 'uuid', name: 'item_id' })
  item_id!: string;

  @Column({ type: 'int', default: 1 })
  quantity!: number;

  @Column({
    type: 'bigint',
    name: 'original_amount_minor',
    transformer: minorUnitsTransformer,
  })
  original_amount_minor!: number;

  @Column({
    type: 'bigint',
    default: 0,
    name: 'discount_amount_minor',
    transformer: minorUnitsTransformer,
  })
  discount_amount_minor!: number;

  @Column({
    type: 'bigint',
    name: 'final_amount_minor',
    transformer: minorUnitsTransformer,
  })
  final_amount_minor!: number;

  @Column({
    type: 'bigint',
    default: 0,
    name: 'refunded_amount_minor',
    transformer: minorUnitsTransformer,
  })
  refunded_amount_minor!: number;

  @Column({ type: 'char', length: 3, default: 'EGP' })
  currency!: string;

  @Column({ type: 'varchar', length: 30, name: 'payment_channel' })
  payment_channel!: PaymentChannel;

  @Column({ type: 'varchar', length: 80, nullable: true, name: 'payment_method' })
  payment_method!: string | null;

  @Column({
    type: 'varchar',
    length: 30,
    default: OrderStatus.AWAITING_PAYMENT,
  })
  status!: OrderStatus;

  @Column({ type: 'uuid', nullable: true, name: 'discount_code_id' })
  discount_code_id!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'activation_code_id' })
  activation_code_id!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'payment_id' })
  payment_id!: string | null;

  @Column({ type: 'varchar', length: 30, default: CollectionParty.UNKNOWN })
  collection_party!: CollectionParty;

  @Column({ type: 'varchar', length: 255, name: 'product_title_snapshot' })
  product_title_snapshot!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'product_title_ar_snapshot' })
  product_title_ar_snapshot!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'seller_name_snapshot' })
  seller_name_snapshot!: string | null;

  @Column({ type: 'int', name: 'platform_commission_bps' })
  platform_commission_bps!: number;

  @Column({
    type: 'bigint',
    name: 'platform_commission_minor',
    transformer: minorUnitsTransformer,
  })
  platform_commission_minor!: number;

  @Column({
    type: 'bigint',
    name: 'teacher_earning_minor',
    transformer: minorUnitsTransformer,
  })
  teacher_earning_minor!: number;

  @Column({ type: 'jsonb', nullable: true, name: 'discount_snapshot' })
  discount_snapshot!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

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
