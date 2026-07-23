import type { Relation } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import type { LessonPackage } from '../../packages/entities/lesson-package.entity';
import { User } from '../../users/entities/user.entity';
import { Payment } from './payment.entity';

@Entity('package_purchases')
@Index('IDX_package_purchases_student_id', ['student_id'])
@Index('IDX_package_purchases_package_id', ['package_id'])
@Index('IDX_package_purchases_payment_id', ['payment_id'])
@Index('UQ_package_purchases_payment_package_student', ['payment_id', 'package_id', 'student_id'], {
  unique: true,
})
export class PackagePurchase {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'uuid', name: 'package_id' })
  package_id!: string;

  @ManyToOne('LessonPackage', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'package_id' })
  package!: Relation<LessonPackage>;

  @Column({ type: 'uuid', name: 'payment_id' })
  payment_id!: string;

  @ManyToOne(() => Payment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'payment_id' })
  payment!: Payment;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'price_paid' })
  price_paid!: number;

  @Column({ type: 'timestamptz', name: 'purchased_at' })
  purchased_at!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'revoked_at' })
  revoked_at!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'revocation_reason' })
  revocation_reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
