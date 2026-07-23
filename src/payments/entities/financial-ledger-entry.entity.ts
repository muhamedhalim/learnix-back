import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { minorUnitsTransformer } from '../money.util';
import { CollectionParty } from './collection-party.enum';
import { LedgerDirection, LedgerEntryStatus, LedgerEntryType } from './ledger.enums';
import { PaymentChannel } from './payment-channel.enum';

@Entity('financial_ledger_entries')
@Index('UQ_financial_ledger_reference', ['reference'], { unique: true })
@Index('IDX_ledger_order', ['order_id'])
@Index('IDX_ledger_teacher_created', ['teacher_id', 'created_at'])
@Index('IDX_ledger_account_currency', ['account', 'currency'])
@Index('IDX_ledger_available', ['entry_type', 'available_at'])
export class FinancialLedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 80 })
  account!: string;

  @Column({ type: 'uuid', name: 'order_id' })
  order_id!: string;

  @Column({ type: 'uuid', nullable: true, name: 'payment_id' })
  payment_id!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'teacher_id' })
  teacher_id!: string | null;

  @Column({ type: 'varchar', length: 50, name: 'entry_type' })
  entry_type!: LedgerEntryType;

  @Column({
    type: 'bigint',
    name: 'amount_minor',
    transformer: minorUnitsTransformer,
  })
  amount_minor!: number;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ type: 'varchar', length: 10 })
  direction!: LedgerDirection;

  @Column({ type: 'varchar', length: 20, default: LedgerEntryStatus.POSTED })
  status!: LedgerEntryStatus;

  @Column({ type: 'timestamptz', nullable: true, name: 'available_at' })
  available_at!: Date | null;

  @Column({ type: 'varchar', length: 30, name: 'source_channel' })
  source_channel!: PaymentChannel;

  @Column({ type: 'varchar', length: 30, name: 'collection_party' })
  collection_party!: CollectionParty;

  @Column({ type: 'varchar', length: 180 })
  reference!: string;

  @Column({ type: 'uuid', nullable: true, name: 'settlement_id' })
  settlement_id!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
