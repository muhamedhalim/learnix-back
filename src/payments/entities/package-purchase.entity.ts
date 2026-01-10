import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { LessonPackage } from '../../packages/entities/lesson-package.entity';
import { Payment } from './payment.entity';

@Entity('package_purchases')
@Index('IDX_package_purchases_student_id', ['student_id'])
@Index('IDX_package_purchases_package_id', ['package_id'])
@Index('IDX_package_purchases_payment_id', ['payment_id'])
export class PackagePurchase {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'int', name: 'package_id' })
  package_id!: number;

  @ManyToOne(() => LessonPackage, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'package_id' })
  package!: LessonPackage;

  @Column({ type: 'int', name: 'payment_id' })
  payment_id!: number;

  @ManyToOne(() => Payment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'payment_id' })
  payment!: Payment;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'price_paid' })
  price_paid!: number;

  @Column({ type: 'timestamptz', name: 'purchased_at' })
  purchased_at!: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
