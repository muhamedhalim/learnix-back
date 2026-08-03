import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CertificateStatus } from './certificate-status.enum';
import { Certificate } from './certificate.entity';

/** Immutable credential state retained before a revoked certificate is reissued. */
@Entity('certificate_history')
@Index('IDX_certificate_history_certificate_created', ['certificate_id', 'created_at'])
@Index('IDX_certificate_history_verification_code', ['verification_code'])
export class CertificateHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'certificate_id' })
  certificate_id!: string;

  @ManyToOne(() => Certificate, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'certificate_id' })
  certificate!: Certificate;

  @Column('varchar', { length: 40, name: 'certificate_number' })
  certificate_number!: string;

  @Column('varchar', { length: 40, name: 'verification_code' })
  verification_code!: string;

  @Column({ type: 'enum', enum: CertificateStatus })
  status!: CertificateStatus;

  @Column('timestamptz', { nullable: true, name: 'revoked_at' })
  revoked_at!: Date | null;

  @Column('text', { nullable: true, name: 'revoke_reason' })
  revoke_reason!: string | null;

  @Column('uuid', { nullable: true, name: 'reissued_by' })
  reissued_by!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
