import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { DiscountCode } from './discount-code.entity';
import { User } from '../../users/entities/user.entity';
import { Payment } from '../../payments/entities/payment.entity';

@Entity('discount_code_usage')
@Index('IDX_discount_usage_code', ['discount_code_id'])
@Index('IDX_discount_usage_user', ['user_id'])
@Index('IDX_discount_usage_payment', ['payment_id'])
@Unique('UQ_discount_code_user', ['discount_code_id', 'user_id'])
export class DiscountCodeUsage {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int', name: 'discount_code_id' })
  discount_code_id!: number;

  @ManyToOne(() => DiscountCode, (code) => code.usages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'discount_code_id' })
  discount_code!: DiscountCode;

  @Column({ type: 'int', name: 'user_id' })
  user_id!: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'int', name: 'payment_id' })
  payment_id!: number;

  @ManyToOne(() => Payment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'payment_id' })
  payment!: Payment;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'discount_amount' })
  discount_amount!: number;

  @CreateDateColumn({ name: 'used_at' })
  used_at!: Date;
}
