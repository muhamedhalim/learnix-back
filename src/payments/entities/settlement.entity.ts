import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { minorUnitsTransformer } from '../money.util';
import { SettlementStatus } from './settlement-status.enum';

@Entity('teacher_settlements')
@Index('UQ_teacher_settlements_number', ['settlement_number'], { unique: true })
@Index('UQ_teacher_settlements_idempotency_key', ['idempotency_key'], { unique: true })
@Index('IDX_teacher_settlements_teacher_status', ['teacher_id', 'status'])
export class Settlement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 40, name: 'settlement_number' })
  settlement_number!: string;

  /** Durable request key for create retries; never recycled across settlements. */
  @Column({ type: 'varchar', length: 120, name: 'idempotency_key' })
  idempotency_key!: string;

  /** SHA-256 of the request semantics, used to reject key reuse with a different payload. */
  @Column({ type: 'char', length: 64, name: 'idempotency_fingerprint' })
  idempotency_fingerprint!: string;

  @Column({ type: 'uuid', name: 'teacher_id' })
  teacher_id!: string;

  @Column({
    type: 'bigint',
    name: 'gross_amount_minor',
    transformer: minorUnitsTransformer,
  })
  gross_amount_minor!: number;

  @Column({
    type: 'bigint',
    default: 0,
    name: 'deductions_minor',
    transformer: minorUnitsTransformer,
  })
  deductions_minor!: number;

  @Column({
    type: 'bigint',
    default: 0,
    name: 'receivable_offset_minor',
    transformer: minorUnitsTransformer,
  })
  receivable_offset_minor!: number;

  @Column({
    type: 'bigint',
    name: 'payout_amount_minor',
    transformer: minorUnitsTransformer,
  })
  payout_amount_minor!: number;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ type: 'varchar', length: 30, default: SettlementStatus.DRAFT })
  status!: SettlementStatus;

  @Column({ type: 'varchar', length: 100, name: 'payment_method' })
  payment_method!: string;

  @Column({ type: 'varchar', length: 180, nullable: true, name: 'transfer_reference' })
  transfer_reference!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'proof_file_key' })
  proof_file_key!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'uuid', name: 'initiated_by' })
  initiated_by!: string;

  @Column({ type: 'uuid', nullable: true, name: 'approved_by' })
  approved_by!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'paid_by' })
  paid_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'paid_at' })
  paid_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
