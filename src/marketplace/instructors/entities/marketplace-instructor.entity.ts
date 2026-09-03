import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../../users/entities/user.entity';
import { MarketplaceInstructorStatus } from '../../common/enums';
import type {
  ApplicationCertificationEntry,
  ApplicationEducationEntry,
  ApplicationPortfolioItem,
  ApplicationProfessionalLink,
  ApplicationWorkExperienceEntry,
} from './instructor-application.entity';
import { InstructorApplication } from './instructor-application.entity';

/** A single pending edit awaiting re-review (FR-029). Keyed by the profile field it targets. */
export interface PendingProfileChange {
  field: string;
  previous_value: unknown;
  proposed_value: unknown;
  requested_at: string;
}

/**
 * The capability record (Q2, FR-009): its existence plus `status = 'approved'`
 * **is** instructor authority. `users.role` is never read or written here.
 * Deliberately collapses the spec's "Instructor Capability" and "Instructor
 * Profile" entities into one table — see data-model.md §1.
 */
@Entity('marketplace_instructors')
@Index('IDX_mp_instructors_status', ['status'])
@Index('UQ_mp_instructors_user_id', ['user_id'], { unique: true })
@Index('UQ_mp_instructors_slug', ['slug'], { unique: true })
@Check('CHK_mp_instructors_suspension_reason', "\"status\" <> 'suspended' OR \"suspension_reason\" IS NOT NULL")
export class MarketplaceInstructor {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'uuid', nullable: true, name: 'application_id' })
  application_id!: string | null;

  @ManyToOne(() => InstructorApplication, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'application_id' })
  application!: InstructorApplication | null;

  @Column({
    type: 'varchar',
    length: 20,
    default: MarketplaceInstructorStatus.APPROVED,
  })
  status!: MarketplaceInstructorStatus;

  /** Stable public address (FR-025); never regenerated on edit. */
  @Column({ type: 'varchar', length: 160 })
  slug!: string;

  @Column({ type: 'varchar', length: 150, name: 'display_name' })
  display_name!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  headline!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'headline_ar' })
  headline_ar!: string | null;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @Column({ type: 'text', nullable: true, name: 'bio_ar' })
  bio_ar!: string | null;

  @Column({ type: 'int', name: 'years_of_experience', default: 0 })
  years_of_experience!: number;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  education!: ApplicationEducationEntry[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  certifications!: ApplicationCertificationEntry[];

  @Column({ type: 'jsonb', default: () => "'[]'", name: 'work_experience' })
  work_experience!: ApplicationWorkExperienceEntry[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  specializations!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  skills!: string[];

  @Column({ type: 'uuid', array: true, default: () => "'{}'", name: 'teaching_category_ids' })
  teaching_category_ids!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'", name: 'portfolio_items' })
  portfolio_items!: ApplicationPortfolioItem[];

  @Column({ type: 'jsonb', default: () => "'[]'", name: 'professional_links' })
  professional_links!: ApplicationProfessionalLink[];

  /** A public image reference (URL), like `users.profile_picture_url` — displayed on the public profile (FR-026). */
  @Column({ type: 'varchar', length: 500, nullable: true, name: 'photo_key' })
  photo_key!: string | null;

  /** Edits requiring re-review; approved values stay live until this clears (FR-029). */
  @Column({ type: 'jsonb', nullable: true, name: 'pending_profile_changes' })
  pending_profile_changes!: PendingProfileChange[] | null;

  @Column({ type: 'text', nullable: true, name: 'suspension_reason' })
  suspension_reason!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'suspended_at' })
  suspended_at!: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'suspended_by' })
  suspended_by!: string | null;

  @Column({ type: 'timestamptz', name: 'approved_at', default: () => 'now()' })
  approved_at!: Date;

  @Column({ type: 'uuid', name: 'approved_by' })
  approved_by!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deleted_at!: Date | null;
}
