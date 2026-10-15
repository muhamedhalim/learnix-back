import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Lesson } from './lesson.entity';

/**
 * A downloadable/previewable resource attached to a lesson
 * (PDF, DOCX, ZIP, image, PowerPoint, audio, …).
 * The file itself lives in storage (object storage / local); we keep its URL.
 */
@Entity('lesson_attachments')
@Index('IDX_lesson_attachments_lesson_id', ['lesson_id'])
export class LessonAttachment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  lesson_id!: string;

  @ManyToOne(() => Lesson, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Lesson;

  @Column({ length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name_ar!: string | null;

  @Column({ length: 1000 })
  url!: string;

  /** Logical type: pdf | docx | zip | image | pptx | audio | other. */
  @Column({ length: 30, default: 'other' })
  type!: string;

  @Column('bigint', { nullable: true })
  size_bytes!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
