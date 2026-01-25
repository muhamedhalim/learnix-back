import { Payment } from '../../payments/entities/payment.entity';
import { User } from '../../users/entities/user.entity';
import { DiscountCode } from './discount-code.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('discount_code_usage')
@Index('IDX_discount_usage_code', ['discount_code_id'])
@Index('IDX_discount_usage_user', ['user_id'])
@Index('IDX_discount_usage_payment', ['payment_id'])
@Unique('UQ_discount_code_user', ['discount_code_id', 'user_id'])
export class DiscountCodeUsage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'discount_code_id' })
  discount_code_id!: string;

  @ManyToOne(() => DiscountCode, (code) => code.usages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'discount_code_id' })
  discount_code!: DiscountCode;

  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'uuid', name: 'payment_id' })
  payment_id!: string;

  @ManyToOne(() => Payment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'payment_id' })
  payment!: Payment;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'discount_amount' })
  discount_amount!: number;

  @CreateDateColumn({ name: 'used_at' })
  used_at!: Date;
}
