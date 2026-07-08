import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * The anti-farming "solved set": one row per (student, question). Gives O(1)
 * answers to "has this student already earned XP/rating for this question?" so
 * repeat solves grant no XP and don't move rating. Also powers the Solved-count
 * and best-time statistics.
 */
@Entity('student_question_states')
@Unique('UQ_student_question_states_user_question', ['user_id', 'question_id'])
export class StudentQuestionState {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  @Index('IDX_student_question_states_user_id')
  user_id!: string;

  @Column({ type: 'uuid', name: 'question_id' })
  question_id!: string;

  /** First time the student answered this question CORRECTLY. Null = never yet. */
  @Column({ type: 'timestamptz', name: 'first_correct_at', nullable: true })
  first_correct_at!: Date | null;

  @Column({ type: 'int', name: 'times_seen', default: 0 })
  times_seen!: number;

  @Column({ type: 'int', name: 'times_correct', default: 0 })
  times_correct!: number;

  @Column({ type: 'int', name: 'best_time_ms', nullable: true })
  best_time_ms!: number | null;

  /** Whether question XP has already been granted (first-solve economy guard). */
  @Column({ type: 'boolean', name: 'xp_earned', default: false })
  xp_earned!: boolean;

  /** Whether this question has already moved the student's rating (first-attempt guard). */
  @Column({ type: 'boolean', name: 'rating_applied', default: false })
  rating_applied!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
