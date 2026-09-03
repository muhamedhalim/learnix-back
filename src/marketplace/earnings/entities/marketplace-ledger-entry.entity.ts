import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { MarketplaceOrder } from '../../commerce/entities';
import { MarketplaceLedgerDirection, MarketplaceLedgerEntryStatus, MarketplaceLedgerEntryType } from '../../common/enums';
import { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';

/**
 * Immutable (FR-157, FR-162) — modelled on `financial_ledger_entries`;
 * separate table per research D2. `UPDATE`/`DELETE` are blocked by a
 * database trigger (`TRG_mp_ledger_immutable`), not just by convention.
 * `payout_request_id` has no `@ManyToOne` here to avoid a circular import
 * with the payouts entities; the FK itself is created by the migration.
 */
@Entity('marketplace_ledger_entries')
@Index('IDX_mp_ledger_instructor_currency', ['instructor_id', 'currency', 'created_at'])
@Index('IDX_mp_ledger_order', ['order_id'])
@Index('IDX_mp_ledger_type_created', ['entry_type', 'created_at'])
@Index('UQ_mp_ledger_reference', ['reference'], { unique: true })
@Check('CHK_mp_ledger_amount_positive', '"amount_minor" > 0')
@Check('CHK_mp_ledger_direction', '"direction" IN (\'credit\',\'debit\')')
@Check(
  'CHK_mp_ledger_adjustment_reason',
  '"entry_type" <> \'manual_adjustment\' OR ("created_by" IS NOT NULL AND "metadata" ? \'reason\')',
)
export class MarketplaceLedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'instructor_id' })
  instructor_id!: string;

  @ManyToOne(() => MarketplaceInstructor, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'instructor_id' })
  instructor!: MarketplaceInstructor;

  /** NULL only for `manual_adjustment`. */
  @Column({ type: 'uuid', nullable: true, name: 'order_id' })
  order_id!: string | null;

  @ManyToOne(() => MarketplaceOrder, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'order_id' })
  order!: MarketplaceOrder | null;

  @Column({ type: 'varchar', length: 40, name: 'entry_type' })
  entry_type!: MarketplaceLedgerEntryType;

  @Column({ type: 'bigint', name: 'amount_minor' })
  amount_minor!: number;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  /** Explicit, never inferred from the sign of `amount_minor` (FR-161). */
  @Column({ type: 'varchar', length: 10 })
  direction!: MarketplaceLedgerDirection;

  @Column({ type: 'varchar', length: 20, default: MarketplaceLedgerEntryStatus.POSTED })
  status!: MarketplaceLedgerEntryStatus;

  /** The idempotency key (FR-171): a replayed webhook or re-run job computes the same value. */
  @Column({ type: 'varchar', length: 180 })
  reference!: string;

  @Column({ type: 'varchar', length: 180, nullable: true, name: 'source_event_id' })
  source_event_id!: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true, name: 'source_event_type' })
  source_event_type!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'payout_request_id' })
  payout_request_id!: string | null;

  /** Required for `manual_adjustment` (FR-168). */
  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  created_by!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
