import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/** Durable retry state for a certificate that could not be issued after completion. */
@Entity('certificate_auto_issuance_failures')
@Unique('UQ_certificate_auto_issuance_failure_course', ['student_id', 'lesson_id', 'package_id'])
@Index('IDX_certificate_auto_issuance_failures_retry', ['resolved_at', 'next_retry_at'])
export class CertificateAutoIssuanceFailure {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'student_id' })
  student_id!: string;

  @Column('uuid', { name: 'lesson_id' })
  lesson_id!: string;

  @Column('uuid', { name: 'package_id' })
  package_id!: string;

  @Column('int', { default: 0 })
  attempts!: number;

  @Column('text', { name: 'last_error' })
  last_error!: string;

  @Column('timestamptz', { name: 'next_retry_at' })
  next_retry_at!: Date;

  @Column('timestamptz', { nullable: true, name: 'resolved_at' })
  resolved_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
