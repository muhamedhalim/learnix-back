import type { Relation } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import type { Exam } from './exam.entity';
import type { OmrTemplateLayout } from './omr-template.types';

/**
 * One generated OMR sheet layout for an exam. `content_hash` fingerprints the
 * exam's OMR-coverable question set (ids, order, type, options) at generation
 * time — `OmrTemplatesService` compares it against the exam's current state to
 * decide whether an existing template is still valid or a new version is
 * needed. Sheets stay bound to the template version they were printed from
 * (`OmrSheet.template_id`), so editing an exam after printing never corrupts
 * an in-flight scan — only *new* sheet generation picks up the latest version.
 */
@Entity('omr_templates')
@Unique('UQ_omr_templates_exam_version', ['exam_id', 'version'])
@Index('IDX_omr_templates_exam_id', ['exam_id'])
export class OmrTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'exam_id' })
  exam_id!: string;

  @ManyToOne('Exam', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'exam_id' })
  exam!: Relation<Exam>;

  @Column({ type: 'int', default: 1 })
  version!: number;

  /** SHA-256 (hex) of the OMR-relevant question set this layout was built from. */
  @Column({ type: 'varchar', length: 64, name: 'content_hash' })
  content_hash!: string;

  @Column({ type: 'jsonb' })
  layout!: OmrTemplateLayout;

  @Column({ type: 'uuid', name: 'created_by' })
  created_by!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'created_by' })
  creator!: Relation<User>;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;
}
