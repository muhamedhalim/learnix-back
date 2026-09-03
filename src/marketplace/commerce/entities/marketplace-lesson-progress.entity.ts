import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { MarketplaceCourseLesson } from '../../catalog/entities';
import { MarketplaceEnrollment } from './marketplace-enrollment.entity';

/**
 * A learner's per-lesson state. Written only by an explicit server-recorded
 * mark-complete action, never by a client-supplied percentage (FR-238, FR-334).
 */
@Entity('marketplace_lesson_progress')
@Index('UQ_mp_progress_enrollment_lesson', ['enrollment_id', 'lesson_id'], { unique: true })
export class MarketplaceLessonProgress {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'enrollment_id' })
  enrollment_id!: string;

  @ManyToOne(() => MarketplaceEnrollment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'enrollment_id' })
  enrollment!: MarketplaceEnrollment;

  @Column({ type: 'uuid', name: 'lesson_id' })
  lesson_id!: string;

  @ManyToOne(() => MarketplaceCourseLesson, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lesson_id' })
  lesson!: MarketplaceCourseLesson;

  @Column({ type: 'boolean', default: false, name: 'is_completed' })
  is_completed!: boolean;

  @Column({ type: 'int', default: 0, name: 'last_position_seconds' })
  last_position_seconds!: number;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completed_at!: Date | null;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
