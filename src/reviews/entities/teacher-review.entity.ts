import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('teacher_reviews')
@Unique('UQ_teacher_review_teacher_student', ['teacher_id', 'student_id'])
@Check('CHK_teacher_review_rating', 'rating >= 1 AND rating <= 5')
@Index('IDX_teacher_reviews_teacher_id', ['teacher_id'])
@Index('IDX_teacher_reviews_student_id', ['student_id'])
@Index('IDX_teacher_reviews_rating', ['rating'])
@Index('IDX_teacher_reviews_created_at', ['created_at'])
export class TeacherReview {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false, name: 'teacher_id' })
  teacher_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'teacher_id' })
  teacher!: User;

  @Column({ type: 'uuid', nullable: false, name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'int', nullable: false })
  rating!: number;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
