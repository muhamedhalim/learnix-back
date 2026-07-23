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

import { Payment } from '../../payments/entities/payment.entity';
import { User } from '../../users/entities/user.entity';
import type { Book } from './book.entity';

@Entity('book_purchases')
@Index('IDX_book_purchases_student_book', ['student_id', 'book_id'], {
  unique: true,
  where: '"revoked_at" IS NULL',
})
export class BookPurchase {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false, name: 'student_id' })
  @Index('IDX_book_purchases_student_id')
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'uuid', nullable: false, name: 'book_id' })
  @Index('IDX_book_purchases_book_id')
  book_id!: string;

  @ManyToOne('Book', 'purchases', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'book_id' })
  book!: Relation<Book>;

  @Column({ type: 'uuid', nullable: false, name: 'payment_id' })
  @Index('IDX_book_purchases_payment_id')
  payment_id!: string;

  @ManyToOne(() => Payment)
  @JoinColumn({ name: 'payment_id' })
  payment!: Payment;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'price_paid' })
  price_paid!: number;

  @Column({ type: 'timestamptz', nullable: true, name: 'revoked_at' })
  revoked_at!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'revocation_reason' })
  revocation_reason!: string | null;

  @CreateDateColumn({ name: 'purchased_at' })
  purchased_at!: Date;
}
