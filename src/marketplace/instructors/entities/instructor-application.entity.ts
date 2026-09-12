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
import { InstructorApplicationStatus } from '../../common/enums';

export interface ApplicationEducationEntry {
  institution: string;
  degree: string;
  field: string;
  start_year: number;
  end_year?: number | null;
}

export interface ApplicationCertificationEntry {
  name: string;
  issuer: string;
  year: number;
  credential_url?: string | null;
}

export interface ApplicationWorkExperienceEntry {
  company: string;
  title: string;
  start_year: number;
  end_year?: number | null;
  summary?: string | null;
}

export interface ApplicationPortfolioItem {
  title: string;
  url: string;
  description?: string | null;
}

export interface ApplicationProfessionalLink {
  kind: 'linkedin' | 'website' | 'github' | 'other';
  url: string;
}

/** FR-009 – FR-024. A person's request to teach on the marketplace (data-model.md §1). */
@Entity('marketplace_instructor_applications')
@Index('IDX_mp_applications_status_submitted', ['status', 'submitted_at'])
@Index('UQ_mp_applications_user_open', ['user_id'], {
  unique: true,
  where: "\"status\" IN ('draft','submitted','under_review','approved')",
})
/** One open public application per email address, mirroring FR-015 for applicants with no account yet. */
@Index('UQ_mp_applications_applicant_email_open', ['applicant_email'], {
  unique: true,
  where: "\"user_id\" IS NULL AND \"status\" IN ('draft','submitted','under_review','approved')",
})
@Check('CHK_mp_applications_reject_reason', "\"status\" <> 'rejected' OR \"decision_reason\" IS NOT NULL")
/** Every application identifies its applicant: an existing account, or contact details to provision one. */
@Check(
  'CHK_mp_applications_applicant_identity',
  '"user_id" IS NOT NULL OR "applicant_email" IS NOT NULL',
)
export class InstructorApplication {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * The applicant's platform identity, or NULL for an application submitted
   * before the applicant had an account at all.
   *
   * A person must be able to apply to teach without first registering into
   * the academic student or teacher lifecycle, so a public application carries
   * its own contact details (`applicant_email` / `applicant_phone`) and gets a
   * `user_id` only at approval, when the account is provisioned. Postgres
   * treats NULLs as distinct in unique indexes, so
   * `UQ_mp_applications_user_open` keeps constraining signed-in applicants
   * exactly as before while anonymous rows are deduplicated by
   * `UQ_mp_applications_applicant_email_open` instead.
   */
  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  user_id!: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user!: User | null;

  /** Contact email for a public application; NULL once/if `user_id` is set at registration time. */
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'applicant_email' })
  applicant_email!: string | null;

  /** Contact phone for a public application, stored canonically (E.164). */
  @Column({ type: 'varchar', length: 30, nullable: true, name: 'applicant_phone' })
  applicant_phone!: string | null;

  @Column({
    type: 'varchar',
    length: 30,
    default: InstructorApplicationStatus.DRAFT,
  })
  status!: InstructorApplicationStatus;

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

  @Column({ type: 'uuid', array: true, default: () => "'{}'", name: 'intended_category_ids' })
  intended_category_ids!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'", name: 'portfolio_items' })
  portfolio_items!: ApplicationPortfolioItem[];

  @Column({ type: 'jsonb', default: () => "'[]'", name: 'professional_links' })
  professional_links!: ApplicationProfessionalLink[];

  /** A public image reference (URL), like `users.profile_picture_url` — FR-026 requires it on the public profile once approved. Not FR-303 private content; `document_keys` below is. */
  @Column({ type: 'varchar', length: 500, nullable: true, name: 'photo_key' })
  photo_key!: string | null;

  /** Optional supporting credential files only — never government identity documents (FR-010). */
  @Column({ type: 'text', array: true, default: () => "'{}'", name: 'document_keys' })
  document_keys!: string[];

  @Column({ type: 'uuid', nullable: true, name: 'reviewed_by' })
  reviewed_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'reviewed_at' })
  reviewed_at!: Date | null;

  /** Mandatory on reject (FR-018) — enforced by CHK_mp_applications_reject_reason. */
  @Column({ type: 'text', nullable: true, name: 'decision_reason' })
  decision_reason!: string | null;

  /** Admin-only; never returned to the applicant. */
  @Column({ type: 'text', nullable: true, name: 'internal_notes' })
  internal_notes!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'submitted_at' })
  submitted_at!: Date | null;

  /** T222 (FR-315) — set once the retention job has purged this decided application's personal content; null means not yet purged. */
  @Column({ type: 'timestamptz', nullable: true, name: 'personal_data_purged_at' })
  personal_data_purged_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
