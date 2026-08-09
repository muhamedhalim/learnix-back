import type { Relation } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Order } from '../../payments/entities/order.entity';
import { Payment } from '../../payments/entities/payment.entity';
import { minorUnitsTransformer } from '../../payments/money.util';
import { User } from '../../users/entities/user.entity';
import { LessonSessionBookingStatus } from './lesson-session-booking-status.enum';
import { ScheduledLessonSession } from './scheduled-lesson-session.entity';

@Entity('lesson_session_bookings')
@Index('IDX_lesson_session_bookings_session_status', ['scheduled_session_id', 'status'])
@Index('IDX_lesson_session_bookings_student_created', ['student_id', 'created_at'])
@Index('IDX_lesson_session_bookings_hold_expiry', ['status', 'hold_expires_at'])
@Index('UQ_lesson_session_bookings_one_active', ['scheduled_session_id'], {
  unique: true,
  where: `"status" IN ('held', 'payment_review', 'confirmed')`,
})
export class LessonSessionBooking {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'scheduled_session_id' })
  scheduled_session_id!: string;

  @ManyToOne(() => ScheduledLessonSession, (session) => session.bookings, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'scheduled_session_id' })
  session!: Relation<ScheduledLessonSession>;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'student_id' })
  student!: Relation<User>;

  @Column({ type: 'uuid', nullable: true, unique: true, name: 'order_id' })
  order_id!: string | null;

  @OneToOne(() => Order, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order!: Relation<Order | null>;

  @Column({ type: 'uuid', nullable: true, unique: true, name: 'payment_id' })
  payment_id!: string | null;

  @OneToOne(() => Payment, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'payment_id' })
  payment!: Relation<Payment | null>;

  @Column({ type: 'enum', enum: LessonSessionBookingStatus })
  status!: LessonSessionBookingStatus;

  @Column({ type: 'timestamptz', name: 'hold_expires_at' })
  hold_expires_at!: Date;

  @Column({ type: 'bigint', name: 'price_minor_snapshot', transformer: minorUnitsTransformer })
  price_minor_snapshot!: number;

  @Column({ type: 'varchar', length: 3, default: 'EGP' })
  currency!: string;

  @Column({ type: 'timestamptz', nullable: true, name: 'confirmed_at' })
  confirmed_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'expired_at' })
  expired_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'failed_at' })
  failed_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'cancelled_at' })
  cancelled_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'refunded_at' })
  refunded_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
