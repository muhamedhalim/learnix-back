import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A reusable certificate design/template. Admins manage these; the renderer
 * substitutes placeholders ({{student}}, {{course}}, {{date}}) in `body`.
 * Exactly one template should carry `is_default = true`.
 */
@Entity('certificate_templates')
@Index('IDX_certificate_templates_is_default', ['is_default'])
export class CertificateTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 160, default: 'Certificate of Completion' })
  title!: string;

  /** Body copy; supports {{student}}, {{course}}, {{date}} placeholders. */
  @Column({
    type: 'text',
    default:
      'This is proudly presented to {{student}} for successfully completing {{course}}.',
  })
  body!: string;

  @Column({ type: 'varchar', length: 120, nullable: true, name: 'signature_name' })
  signature_name!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true, name: 'signature_title' })
  signature_title!: string | null;

  /** Accent colour (hex) used for borders/headings in the rendered PDF. */
  @Column({ type: 'varchar', length: 9, default: '#6d28d9', name: 'accent_color' })
  accent_color!: string;

  @Column({ type: 'boolean', default: false, name: 'is_default' })
  is_default!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
