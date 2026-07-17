import type { Relation } from 'typeorm';
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

import { Lesson } from '../../lessons/entities/lesson.entity';
import { LessonPackage } from '../../packages/entities/lesson-package.entity';
import { Subject } from '../../subjects/entities/subject.entity';
import { User } from '../../users/entities/user.entity';
import type { ExamAttempt } from './exam-attempt.entity';
import type { ExamConfig } from './exam-config.interface';
import type { ExamQuestion } from './exam-question.entity';
import type { ExamSection } from './exam-section.entity';
import { ExamStatus } from './exam-status.enum';

/**
 * An exam definition. Questions are attached via {@link ExamQuestion} rows
 * (referencing bank questions), grouped into {@link ExamSection}s. Policy lives
 * in `config` (JSONB). `total_marks` is derived from the attached questions and
 * kept denormalised for fast listing.
 */
@Entity('exams')
export class Exam {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'teacher_id' })
  @Index('IDX_exams_teacher_id')
  teacher_id!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'teacher_id' })
  teacher!: User;

  @Column({ type: 'uuid', name: 'subject_id' })
  @Index('IDX_exams_subject_id')
  subject_id!: string;

  @ManyToOne(() => Subject)
  @JoinColumn({ name: 'subject_id' })
  subject!: Subject;

  /** Optional linkage used both for access gating and per-lesson analytics. */
  @Column({ type: 'uuid', nullable: true, name: 'lesson_id' })
  @Index('IDX_exams_lesson_id')
  lesson_id!: string | null;

  @ManyToOne(() => Lesson, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Relation<Lesson> | null;

  /** Optional course audience. New private exams target a course or a lesson. */
  @Column({ type: 'uuid', nullable: true, name: 'package_id' })
  @Index('IDX_exams_package_id')
  package_id!: string | null;

  @ManyToOne(() => LessonPackage, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'package_id' })
  package!: Relation<LessonPackage> | null;

  @Column({ type: 'varchar', length: 255 })
  @Index('IDX_exams_title')
  title!: string;

  @Column({ type: 'varchar', length: 255, name: 'title_ar' })
  title_ar!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true, name: 'description_ar' })
  description_ar!: string | null;

  @Column({ type: 'enum', enum: ExamStatus, default: ExamStatus.DRAFT })
  @Index('IDX_exams_status')
  status!: ExamStatus;

  /** Public quizzes are never mixed into the instructor-assigned exam feed. */
  @Column({ type: 'boolean', name: 'is_public', default: false })
  @Index('IDX_exams_is_public')
  is_public!: boolean;

  @Column({ type: 'jsonb' })
  config!: ExamConfig;

  @Column({ type: 'int', name: 'total_marks', default: 0 })
  total_marks!: number;

  @Column({ type: 'int', name: 'passing_marks', default: 0 })
  passing_marks!: number;

  @OneToMany('ExamSection', 'exam')
  sections!: Relation<ExamSection[]>;

  @OneToMany('ExamQuestion', 'exam')
  exam_questions!: Relation<ExamQuestion[]>;

  @OneToMany('ExamAttempt', 'exam')
  attempts!: Relation<ExamAttempt[]>;

  @CreateDateColumn({ name: 'created_at' })
  @Index('IDX_exams_created_at')
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  @Index('IDX_exams_deleted_at')
  deleted_at!: Date | null;
}
