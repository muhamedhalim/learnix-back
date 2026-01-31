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

import type { LessonPurchase } from '../../payments/entities/lesson-purchase.entity';
import { Subject } from '../../subjects/entities/subject.entity';
import { User } from '../../users/entities/user.entity';

@Entity('lessons')
export class Lesson {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  @Index('IDX_lessons_title')
  title!: string;

  @Column({ type: 'varchar', length: 255, nullable: false, name: 'title_ar' })
  @Index('IDX_lessons_title_ar')
  title_ar!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true, name: 'description_ar' })
  description_ar!: string | null;

  @Column({ type: 'uuid', nullable: false, name: 'teacher_id' })
  @Index('IDX_lessons_teacher_id')
  teacher_id!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'teacher_id' })
  teacher!: User;

  @Column({ type: 'uuid', nullable: false, name: 'subject_id' })
  @Index('IDX_lessons_subject_id')
  subject_id!: string;

  @ManyToOne(() => Subject)
  @JoinColumn({ name: 'subject_id' })
  subject!: Subject;

  @Column({ type: 'varchar', length: 500, nullable: true })
  thumbnail!: string | null;

  // Primary video fields (Bunny.net)
  @Column({ type: 'varchar', length: 500, nullable: true, name: 'video_url' })
  video_url!: string | null;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'bunny',
    name: 'video_platform',
  })
  @Index('IDX_lessons_video_platform')
  video_platform!: 'bunny' | 'vimeo';

  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
    name: 'bunny_video_id',
  })
  bunny_video_id!: string | null;

  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
    name: 'bunny_library_id',
  })
  bunny_library_id!: string | null;

  // Legacy Vimeo fields (for backward compatibility during migration)
  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
    name: 'vimeo_video_id',
  })
  vimeo_video_id!: string | null;

  @Column({
    type: 'varchar',
    length: 500,
    nullable: true,
    name: 'vimeo_embed_url',
  })
  vimeo_embed_url!: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false })
  price!: number;

  @Column({ type: 'int', nullable: true })
  duration!: number | null; // Duration in seconds

  @Column({ type: 'boolean', default: false, name: 'is_group' })
  is_group!: boolean;

  @Column({ type: 'int', default: 7, name: 'available_for_days' })
  available_for_days!: number;

  @Column({ type: 'int', default: 0, name: 'students_count' })
  students_count!: number;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at!: Date | null;

  // Phase 4: Payment relations
  @OneToMany('LessonPurchase', 'lesson')
  purchases!: Relation<LessonPurchase[]>;
}
