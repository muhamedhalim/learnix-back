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

import type { ParentEventType } from '../../common/events/parent-event-type.enum';
import { User } from '../../users/entities/user.entity';
import { Guardian } from './guardian.entity';
import { GuardianRelationship } from './guardian-relationship.enum';

/**
 * The many-to-many link between a student and a guardian.
 *
 * Preferences live on the *link*, not on the guardian: a father may want exam
 * results for his son in secondary school but not the daily attendance pings
 * for his daughter in primary. Exactly one link per student may be primary,
 * enforced by a partial unique index (see the migration).
 */
@Entity('student_guardians')
@Index('IDX_student_guardians_student', ['student_id'])
@Index('IDX_student_guardians_guardian', ['guardian_id'])
@Index('UQ_student_guardians_pair', ['student_id', 'guardian_id'], { unique: true })
export class StudentGuardian {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'uuid', name: 'guardian_id' })
  guardian_id!: string;

  @ManyToOne(() => Guardian, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'guardian_id' })
  guardian!: Guardian;

  @Column({
    type: 'enum',
    enum: GuardianRelationship,
    default: GuardianRelationship.OTHER,
  })
  relationship!: GuardianRelationship;

  /** At most one primary guardian per student (partial unique index). */
  @Column({ type: 'boolean', default: false, name: 'is_primary' })
  is_primary!: boolean;

  /** Master switch for this pairing; ANDed with `notification_preferences`. */
  @Column({ type: 'boolean', default: true, name: 'receives_notifications' })
  receives_notifications!: boolean;

  /**
   * Sparse `ParentEventType → boolean` overrides. Absent keys fall back to
   * `DEFAULT_PARENT_NOTIFICATION_PREFERENCES`, so adding a new event type never
   * requires backfilling every row. Mirrors the existing
   * `student_profiles.notification_settings` jsonb convention.
   */
  @Column({
    type: 'jsonb',
    default: '{}',
    name: 'notification_preferences',
  })
  notification_preferences!: Partial<Record<ParentEventType, boolean>>;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
