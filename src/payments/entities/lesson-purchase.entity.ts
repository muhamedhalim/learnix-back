import { Lesson } from '../../lessons/entities/lesson.entity';
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
  UpdateDateColumn,
} from 'typeorm';

@Entity('lesson_purchases')
@Index('IDX_lesson_purchases_student_id', ['student_id'])
@Index('IDX_lesson_purchases_lesson_id', ['lesson_id'])
@Index('IDX_lesson_purchases_payment_id', ['payment_id'])
@Index('IDX_lesson_purchases_expires_at', ['access_expires_at'])
@Index('IDX_lesson_purchases_student_lesson', ['student_id', 'lesson_id'])
export class LessonPurchase {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'uuid', name: 'lesson_id' })
  lesson_id!: string;

  @ManyToOne(() => Lesson, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Lesson;

  @Column({ type: 'uuid', name: 'payment_id' })
  payment_id!: string;

  @ManyToOne(() => Payment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'payment_id' })
  payment!: Payment;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'price_paid' })
  price_paid!: number;

  @Column({ type: 'timestamptz', name: 'access_granted_at' })
  access_granted_at!: Date;

  @Column({ type: 'timestamptz', name: 'access_expires_at' })
  access_expires_at!: Date;

  @Column({ type: 'int', default: 0, name: 'days_extended' })
  days_extended!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
