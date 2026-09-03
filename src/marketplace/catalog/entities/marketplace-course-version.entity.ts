import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { MarketplaceCourse } from './marketplace-course.entity';

/** An immutable publication snapshot (FR-074, FR-075) — what a buyer purchased stays stable. */
@Entity('marketplace_course_versions')
@Index('UQ_mp_versions_course_number', ['course_id', 'version_number'], { unique: true })
export class MarketplaceCourseVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'course_id' })
  course_id!: string;

  @ManyToOne(() => MarketplaceCourse, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'course_id' })
  course!: MarketplaceCourse;

  @Column({ type: 'int', name: 'version_number' })
  version_number!: number;

  @Column({ type: 'jsonb' })
  snapshot!: Record<string, unknown>;

  @Column({ type: 'timestamptz', name: 'published_at', default: () => 'now()' })
  published_at!: Date;

  @Column({ type: 'uuid', name: 'published_by' })
  published_by!: string;
}
