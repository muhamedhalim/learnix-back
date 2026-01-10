import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { Subject } from '../../subjects/entities/subject.entity';
import { User } from '../../users/entities/user.entity';
import { BookPurchase } from './book-purchase.entity';

@Entity('books')
export class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 255, nullable: false })
  @Index('IDX_books_title')
  title!: string;

  @Column({ type: 'varchar', length: 255, nullable: false, name: 'title_ar' })
  @Index('IDX_books_title_ar')
  title_ar!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true, name: 'description_ar' })
  description_ar!: string | null;

  @Column({ type: 'int', nullable: false, name: 'teacher_id' })
  @Index('IDX_books_teacher_id')
  teacher_id!: number;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'teacher_id' })
  teacher!: User;

  @Column({ type: 'int', nullable: false, name: 'subject_id' })
  @Index('IDX_books_subject_id')
  subject_id!: number;

  @ManyToOne(() => Subject)
  @JoinColumn({ name: 'subject_id' })
  subject!: Subject;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'cover_image' })
  cover_image!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: false, name: 'book_file' })
  book_file!: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false })
  price!: number;

  @Column({ type: 'int', default: 0, name: 'purchase_count' })
  purchase_count!: number;

  @CreateDateColumn({ name: 'created_at' })
  @Index('IDX_books_created_at')
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at!: Date | null;

  @OneToMany(() => BookPurchase, (purchase) => purchase.book)
  purchases!: BookPurchase[];
}
