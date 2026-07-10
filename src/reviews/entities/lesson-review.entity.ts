import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { Lesson } from '../../lessons/entities/lesson.entity';
import { User } from '../../users/entities/user.entity';
import { ReviewStatus } from './review-status.enum';

@Entity('lesson_reviews')
@Unique('UQ_lesson_review_lesson_student', ['lesson_id', 'student_id'])
@Check('CHK_lesson_review_rating', 'rating >= 1 AND rating <= 5')
@Index('IDX_lesson_reviews_lesson_id', ['lesson_id'])
@Index('IDX_lesson_reviews_student_id', ['student_id'])
@Index('IDX_lesson_reviews_rating', ['rating'])
@Index('IDX_lesson_reviews_created_at', ['created_at'])
@Index('IDX_lesson_reviews_status', ['status'])
export class LessonReview {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false, name: 'lesson_id' })
  lesson_id!: string;

  @ManyToOne(() => Lesson, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Lesson;

  @Column({ type: 'uuid', nullable: false, name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'int', nullable: false })
  rating!: number;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({
    type: 'enum',
    enum: ReviewStatus,
    default: ReviewStatus.APPROVED,
  })
  status!: ReviewStatus;

  @Column({ type: 'int', default: 0, name: 'helpful_count' })
  helpful_count!: number;

  /** Teacher's public reply to this review (teacher of the reviewed lesson). */
  @Column({ type: 'text', nullable: true, name: 'teacher_reply' })
  teacher_reply!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'teacher_reply_at' })
  teacher_reply_at!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
