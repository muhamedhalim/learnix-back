import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { minorUnitsTransformer } from '../money.util';
import { ManualPaymentSubmissionStatus } from './manual-payment-status.enum';

@Entity('manual_payment_submissions')
@Index('IDX_manual_submissions_status_submitted', ['status', 'submitted_at'])
@Index('IDX_manual_submissions_order', ['order_id'])
@Index('IDX_manual_submissions_student', ['student_id'])
@Index('IDX_manual_submissions_reference', ['manual_payment_method_id', 'transaction_reference'])
@Index('IDX_manual_submissions_proof_hash', ['proof_sha256'])
export class ManualPaymentSubmission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'order_id' })
  order_id!: string;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @Column({ type: 'uuid', name: 'manual_payment_method_id' })
  manual_payment_method_id!: string;

  @Column({
    type: 'bigint',
    name: 'claimed_amount_minor',
    transformer: minorUnitsTransformer,
  })
  claimed_amount_minor!: number;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ type: 'varchar', length: 160, name: 'payer_name' })
  payer_name!: string;

  @Column({ type: 'varchar', length: 32, nullable: true, name: 'payer_account_hint' })
  payer_account_hint!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true, name: 'transaction_reference' })
  transaction_reference!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'paid_at_claimed' })
  paid_at_claimed!: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'proof_file_key' })
  proof_file_key!: string | null;

  @Column({ type: 'char', length: 64, nullable: true, name: 'proof_sha256' })
  proof_sha256!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'proof_mime_type' })
  proof_mime_type!: string | null;

  @Column({ type: 'text', nullable: true, name: 'student_note' })
  student_note!: string | null;

  @Column({
    type: 'varchar',
    length: 40,
    default: ManualPaymentSubmissionStatus.SUBMITTED,
  })
  status!: ManualPaymentSubmissionStatus;

  @Column({ type: 'timestamptz', name: 'submitted_at' })
  submitted_at!: Date;

  @Column({ type: 'uuid', nullable: true, name: 'reviewed_by' })
  reviewed_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'reviewed_at' })
  reviewed_at!: Date | null;

  @Column({ type: 'varchar', length: 60, nullable: true, name: 'rejection_reason_code' })
  rejection_reason_code!: string | null;

  @Column({ type: 'text', nullable: true, name: 'rejection_reason' })
  rejection_reason!: string | null;

  @Column({ type: 'text', nullable: true, name: 'reviewer_note' })
  reviewer_note!: string | null;

  @Column({ type: 'int', default: 0, name: 'revision_count' })
  revision_count!: number;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
