import { Subject } from '../../subjects/entities/subject.entity';
import { User } from '../../users/entities/user.entity';
import { ExamAttempt } from './exam-attempt.entity';
import { Question } from './question.interface';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('exams')
export class Exam {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  @Index('IDX_exams_title')
  title!: string;

  @Column({ type: 'varchar', length: 255, nullable: false, name: 'title_ar' })
  @Index('IDX_exams_title_ar')
  title_ar!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true, name: 'description_ar' })
  description_ar!: string | null;

  @Column({ type: 'uuid', nullable: false, name: 'teacher_id' })
  @Index('IDX_exams_teacher_id')
  teacher_id!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'teacher_id' })
  teacher!: User;

  @Column({ type: 'uuid', nullable: false, name: 'subject_id' })
  @Index('IDX_exams_subject_id')
  subject_id!: string;

  @ManyToOne(() => Subject)
  @JoinColumn({ name: 'subject_id' })
  subject!: Subject;

  /**
   * JSONB array of Question objects
   * Contains MCQ and/or Essay questions with their marks
   */
  @Column({ type: 'jsonb', nullable: false })
  questions!: Question[];

  /**
   * Total marks (calculated from sum of all question marks)
   */
  @Column({ type: 'int', nullable: false, name: 'total_marks' })
  total_marks!: number;

  /**
   * Passing marks (must be <= total_marks)
   */
  @Column({ type: 'int', nullable: false, name: 'passing_marks' })
  passing_marks!: number;

  /**
   * Duration in seconds
   */
  @Column({ type: 'int', nullable: false })
  duration!: number;

  /**
   * Whether the exam is active and available for students
   */
  @Column({ type: 'boolean', default: true, name: 'is_active' })
  @Index('IDX_exams_is_active')
  is_active!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  @Index('IDX_exams_deleted_at')
  deleted_at!: Date | null;

  // Relations
  @OneToMany(() => ExamAttempt, (attempt) => attempt.exam)
  attempts!: ExamAttempt[];
}
