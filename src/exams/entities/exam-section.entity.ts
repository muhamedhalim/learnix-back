import type { Relation } from 'typeorm';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

import type { Exam } from './exam.entity';
import type { ExamQuestion } from './exam-question.entity';

/**
 * A group of questions within an exam. Enables Case Study / Reading
 * Comprehension / multi-part structures (a shared stimulus + several
 * sub-questions) without any special question type — the section is the
 * grouping, its questions are ordinary bank questions.
 */
@Entity('exam_sections')
export class ExamSection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'exam_id' })
  @Index('IDX_exam_sections_exam_id')
  exam_id!: string;

  @ManyToOne('Exam', 'sections', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'exam_id' })
  exam!: Relation<Exam>;

  @Column({ type: 'int', name: 'order_index', default: 0 })
  order_index!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'title_ar' })
  title_ar!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'boolean', name: 'shuffle_questions', default: false })
  shuffle_questions!: boolean;

  @OneToMany('ExamQuestion', 'section')
  exam_questions!: Relation<ExamQuestion[]>;
}
