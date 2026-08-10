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

import { LessonPackage } from '../../packages/entities/lesson-package.entity';
import { User } from '../../users/entities/user.entity';
import { CertificateStatus } from './certificate-status.enum';
import type { CertificateTemplate } from './certificate-template.entity';

/**
 * The design fields frozen into a certificate at issue time. Editing (or even
 * deleting) the source template later never changes an issued certificate —
 * the renderer prefers this snapshot over the live template.
 */
export type CertificateTemplateSnapshot = Pick<
  CertificateTemplate,
  | 'title'
  | 'title_ar'
  | 'body'
  | 'body_ar'
  | 'signature_name'
  | 'signature_title'
  | 'signature_title_ar'
  | 'accent_color'
  | 'layout'
  | 'font'
  | 'title_font_size'
  | 'body_font_size'
  | 'text_alignment'
>;

/**
 * Why a certificate was revoked, in machine-readable form.
 *
 * `manual` is an admin/teacher decision; `refund` is the automatic revocation
 * that rides along with a completed FULL refund (DEF-019) and carries the
 * refund/order/payment that withdrew the underlying course access;
 * `refund_backfill` marks rows revoked by the one-off historical backfill for
 * refunds that completed before that policy was enforced.
 */
export interface CertificateRevocationContext {
  source: 'manual' | 'refund' | 'refund_backfill';
  refund_id?: string;
  order_id?: string;
  payment_id?: string;
  package_purchase_id?: string;
}

/**
 * An issued course-completion certificate.
 *
 * Student/course/teacher names AND the template design are snapshotted at
 * issue time so a certificate remains a stable historical record even if the
 * underlying names or template later change.
 * One certificate per (student, course) — enforced by the unique constraint.
 *
 * `verification_code` doubles as the certificate's public id: it is a
 * high-entropy capability token, so public URLs never expose the DB id.
 */
@Entity('certificates')
@Unique('UQ_certificate_student_package', ['student_id', 'package_id'])
@Index('IDX_certificates_student_id', ['student_id'])
@Index('IDX_certificates_package_id', ['package_id'])
@Index('IDX_certificates_verification_code', ['verification_code'], { unique: true })
@Index('IDX_certificates_number', ['certificate_number'], { unique: true })
@Index('IDX_certificates_public_gallery', ['is_public', 'status', 'issued_at'])
export class Certificate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 40, name: 'certificate_number' })
  certificate_number!: string;

  @Column({ type: 'varchar', length: 40, name: 'verification_code' })
  verification_code!: string;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'uuid', name: 'package_id' })
  package_id!: string;

  @ManyToOne(() => LessonPackage, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'package_id' })
  package!: LessonPackage;

  @Column({ type: 'varchar', length: 200, name: 'student_name' })
  student_name!: string;

  @Column({ type: 'varchar', length: 200, name: 'course_title' })
  course_title!: string;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'teacher_name' })
  teacher_name!: string | null;

  @Column({ type: 'int', default: 100, name: 'completion_percentage' })
  completion_percentage!: number;

  @Column({ type: 'uuid', nullable: true, name: 'template_id' })
  template_id!: string | null;

  @Column({
    type: 'enum',
    enum: CertificateStatus,
    default: CertificateStatus.ISSUED,
  })
  status!: CertificateStatus;

  /** Student-controlled: whether this certificate appears in the public gallery. */
  @Column({ type: 'boolean', default: false, name: 'is_public' })
  is_public!: boolean;

  /** Frozen design at issue time; null only for legacy pre-snapshot rows. */
  @Column({ type: 'jsonb', nullable: true, name: 'template_snapshot' })
  template_snapshot!: CertificateTemplateSnapshot | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'revoked_at' })
  revoked_at!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'revoke_reason' })
  revoke_reason!: string | null;

  /** Who asked for the revocation; null when the platform revoked automatically. */
  @Column({ type: 'uuid', nullable: true, name: 'revoked_by' })
  revoked_by!: string | null;

  /** Machine-readable cause — which refund/order/payment withdrew access. */
  @Column({ type: 'jsonb', nullable: true, name: 'revocation_context' })
  revocation_context!: CertificateRevocationContext | null;

  @Column({ type: 'timestamptz', name: 'issued_at' })
  issued_at!: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
