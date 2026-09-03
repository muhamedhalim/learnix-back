import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { MarketplaceCourse } from './marketplace-course.entity';

/** An ordered grouping of lessons within a course (data-model.md §2). */
@Entity('marketplace_course_sections')
@Index('UQ_mp_sections_course_position', ['course_id', 'position'], { unique: true })
export class MarketplaceCourseSection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'course_id' })
  course_id!: string;

  @ManyToOne(() => MarketplaceCourse, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'course_id' })
  course!: MarketplaceCourse;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'title_ar' })
  title_ar!: string | null;

  @Column({ type: 'int' })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
