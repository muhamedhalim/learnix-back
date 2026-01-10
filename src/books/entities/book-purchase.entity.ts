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
import { Book } from './book.entity';
import { Payment } from '../../payments/entities/payment.entity';

@Entity('book_purchases')
@Index('IDX_book_purchases_student_book', ['student_id', 'book_id'], {
  unique: true,
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

  @ManyToOne(() => Book, (book) => book.purchases, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'book_id' })
  book!: Book;

  @Column({ type: 'uuid', nullable: false, name: 'payment_id' })
  @Index('IDX_book_purchases_payment_id')
  payment_id!: string;

  @ManyToOne(() => Payment)
  @JoinColumn({ name: 'payment_id' })
  payment!: Payment;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'price_paid' })
  price_paid!: number;

  @CreateDateColumn({ name: 'purchased_at' })
  purchased_at!: Date;
}
