import { User } from '../../users/entities/user.entity';
import { Exam } from './exam.entity';
import { ExamStatus } from './exam-status.enum';
import { Answer } from './question.interface';
import {
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

/**
 * ExamAttempt tracks student submissions and grading progress
 *
 * Key features:
 * - Unique constraint on (exam_id, student_id) enforces one attempt per exam
 * - JSONB answers array stores student responses with scores
 * - Status tracks grading progress (in_progress -> pending_grading -> graded)
 */
@Entity('exam_attempts')
@Unique('UQ_exam_attempts_exam_student', ['exam_id', 'student_id'])
@Index('IDX_exam_attempts_exam_id', ['exam_id'])
@Index('IDX_exam_attempts_student_id', ['student_id'])
@Index('IDX_exam_attempts_status', ['status'])
export class ExamAttempt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false, name: 'exam_id' })
  exam_id!: string;

  @ManyToOne(() => Exam, (exam) => exam.attempts)
  @JoinColumn({ name: 'exam_id' })
  exam!: Exam;

  @Column({ type: 'uuid', nullable: false, name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'student_id' })
  student!: User;

  /**
   * JSONB array of Answer objects
   * Contains student answers with scores (auto-graded for MCQ, manual for essays)
   */
  @Column({ type: 'jsonb', nullable: false })
  answers!: Answer[];

  /**
   * Score from MCQ questions (auto-calculated on submission)
   */
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    name: 'score_mcq',
  })
  score_mcq!: number | null;

  /**
   * Score from essay questions (accumulated as teacher grades)
   */
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    name: 'score_essay',
  })
  score_essay!: number | null;

  /**
   * Total score (score_mcq + score_essay)
   * Only populated when all questions are graded (status = GRADED)
   */
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    name: 'total_score',
  })
  total_score!: number | null;

  /**
   * Grading status
   * - IN_PROGRESS: Started but not submitted
   * - SUBMITTED: Just submitted (intermediate)
   * - PENDING_GRADING: Submitted with essays awaiting grading
   * - GRADED: All questions graded
   */
  @Column({
    type: 'varchar',
    length: 20,
    nullable: false,
    default: ExamStatus.IN_PROGRESS,
  })
  status!: ExamStatus;

  /**
   * When the student submitted their answers
   */
  @Column({ type: 'timestamp', nullable: true, name: 'submitted_at' })
  submitted_at!: Date | null;

  /**
   * When all questions were graded (essays manually, MCQ auto)
   */
  @Column({ type: 'timestamp', nullable: true, name: 'graded_at' })
  graded_at!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
