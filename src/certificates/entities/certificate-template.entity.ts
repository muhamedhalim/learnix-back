import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { CertificateTemplateStatus } from './certificate-template-status.enum';

/**
 * A reusable certificate design/template. Admins manage these; the renderer
 * substitutes placeholders ({{student}}, {{course}}, {{date}}) in `body`.
 * Exactly one template should carry `is_default = true`.
 *
 * A template is NOT a certificate: publishing a template only makes the design
 * available for issuance — issued certificates are separate `Certificate` rows
 * carrying a frozen snapshot of this design.
 */
@Entity('certificate_templates')
@Index('IDX_certificate_templates_is_default', ['is_default'])
export class CertificateTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  /** Null for platform templates managed by admins; set for teacher-owned templates. */
  @Column({ type: 'uuid', nullable: true, name: 'owner_id' })
  @Index('IDX_certificate_templates_owner_id')
  owner_id!: string | null;

  @Column({ type: 'varchar', length: 160, default: 'Certificate of Completion' })
  title!: string;

  @Column({ type: 'varchar', length: 160, nullable: true, name: 'title_ar' })
  title_ar!: string | null;

  /** Body copy; supports {{student}}, {{course}}, {{date}} placeholders. */
  @Column({
    type: 'text',
    default: 'This is proudly presented to {{student}} for successfully completing {{course}}.',
  })
  body!: string;

  @Column({ type: 'text', nullable: true, name: 'body_ar' })
  body_ar!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true, name: 'signature_name' })
  signature_name!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true, name: 'signature_title' })
  signature_title!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true, name: 'signature_title_ar' })
  signature_title_ar!: string | null;

  /** Accent colour (hex) used for borders/headings in the rendered PDF. */
  @Column({ type: 'varchar', length: 9, default: '#6d28d9', name: 'accent_color' })
  accent_color!: string;

  /** Fixed, reviewed layouts only — never arbitrary user-supplied HTML/CSS. */
  @Column({ type: 'varchar', length: 24, default: 'classic' })
  layout!: 'classic' | 'modern' | 'minimal';

  @Column({ type: 'varchar', length: 24, default: 'sans' })
  font!: 'sans' | 'serif';

  @Column({ type: 'smallint', default: 34, name: 'title_font_size' })
  title_font_size!: number;

  @Column({ type: 'smallint', default: 16, name: 'body_font_size' })
  body_font_size!: number;

  @Column({ type: 'varchar', length: 12, default: 'center', name: 'text_alignment' })
  text_alignment!: 'left' | 'center' | 'right';

  @Column({ type: 'boolean', default: false, name: 'is_default' })
  is_default!: boolean;

  @Column({
    type: 'enum',
    enum: CertificateTemplateStatus,
    enumName: 'certificate_template_status_enum',
    default: CertificateTemplateStatus.DRAFT,
  })
  @Index('IDX_certificate_templates_status')
  status!: CertificateTemplateStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
