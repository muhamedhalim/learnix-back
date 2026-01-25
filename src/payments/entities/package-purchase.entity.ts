import { LessonPackage } from '../../packages/entities/lesson-package.entity';
import { User } from '../../users/entities/user.entity';
import { Payment } from './payment.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('package_purchases')
@Index('IDX_package_purchases_student_id', ['student_id'])
@Index('IDX_package_purchases_package_id', ['package_id'])
@Index('IDX_package_purchases_payment_id', ['payment_id'])
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

  @ManyToOne(() => LessonPackage, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'package_id' })
  package!: LessonPackage;

  @Column({ type: 'uuid', name: 'payment_id' })
  payment_id!: string;

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
