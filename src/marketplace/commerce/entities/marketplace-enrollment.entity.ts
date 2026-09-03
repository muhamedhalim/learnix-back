import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../../users/entities/user.entity';
import { MarketplaceCourse, MarketplaceCourseVersion } from '../../catalog/entities';
import { MarketplaceEnrollmentStatus } from '../../common/enums';
import { MarketplaceOrder } from './marketplace-order.entity';

/**
 * The marketplace's own access grant (D1). No `expired` value: access is
 * perpetual unless suspended or revoked (FR-106).
 */
@Entity('marketplace_enrollments')
@Index('UQ_mp_enrollments_active_learner_course', ['learner_id', 'course_id'], {
  unique: true,
  where: "\"status\" = 'active'",
})
@Index('IDX_mp_enrollments_course', ['course_id'])
@Index('UQ_mp_enrollments_order', ['order_id'], { unique: true })
@Check('CHK_mp_enrollments_progress_range', '"progress_bps" >= 0 AND "progress_bps" <= 10000')
export class MarketplaceEnrollment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'learner_id' })
  learner_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'learner_id' })
  learner!: User;

  @Column({ type: 'uuid', name: 'course_id' })
  course_id!: string;

  @ManyToOne(() => MarketplaceCourse, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'course_id' })
  course!: MarketplaceCourse;

  @Column({ type: 'uuid', name: 'course_version_id' })
  course_version_id!: string;

  @ManyToOne(() => MarketplaceCourseVersion, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'course_version_id' })
  course_version!: MarketplaceCourseVersion;

  @Column({ type: 'uuid', name: 'order_id' })
  order_id!: string;

  @ManyToOne(() => MarketplaceOrder, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order!: MarketplaceOrder;

  @Column({ type: 'varchar', length: 20, default: MarketplaceEnrollmentStatus.ACTIVE })
  status!: MarketplaceEnrollmentStatus;

  @Column({ type: 'timestamptz', name: 'granted_at', default: () => 'now()' })
  granted_at!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'revoked_at' })
  revoked_at!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'revocation_reason' })
  revocation_reason!: string | null;

  /** Required-lesson completion, `floor(completed_required * 10000 / total_required)` (FR-240). */
  @Column({ type: 'int', default: 0, name: 'progress_bps' })
  progress_bps!: number;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completed_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
