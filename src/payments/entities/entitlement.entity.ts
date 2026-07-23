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
import { EntitlementStatus } from './entitlement-status.enum';
import { ItemType } from './item-type.enum';
import { PaymentChannel } from './payment-channel.enum';

@Entity('entitlements')
@Index('UQ_entitlements_order', ['order_id'], { unique: true })
@Index(
  'UQ_entitlements_order_product_student',
  ['order_id', 'student_id', 'item_type', 'item_id'],
  {
    unique: true,
  },
)
@Index('IDX_entitlements_student_item_status', ['student_id', 'item_type', 'item_id', 'status'])
@Index('IDX_entitlements_expires_at', ['expires_at'])
export class Entitlement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'varchar', length: 30, name: 'item_type' })
  item_type!: ItemType;

  @Column({ type: 'uuid', name: 'item_id' })
  item_id!: string;

  @Column({ type: 'uuid', name: 'order_id' })
  order_id!: string;

  @Column({ type: 'uuid', nullable: true, name: 'payment_id' })
  payment_id!: string | null;

  @Column({ type: 'varchar', length: 30, name: 'source_channel' })
  source_channel!: PaymentChannel;

  @Column({ type: 'varchar', length: 20, default: EntitlementStatus.ACTIVE })
  status!: EntitlementStatus;

  @Column({ type: 'timestamptz', name: 'granted_at' })
  granted_at!: Date;

  @Column({ type: 'timestamptz', name: 'starts_at' })
  starts_at!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'expires_at' })
  expires_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'revoked_at' })
  revoked_at!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'revocation_reason' })
  revocation_reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
