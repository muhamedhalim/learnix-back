import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { minorUnitsTransformer } from '../../../payments/money.util';
import { PayoutRequestStatus } from '../../common/enums';
import { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';
import { MarketplacePayoutAccount } from './marketplace-payout-account.entity';

/**
 * FR-206 – FR-226. FR-210/FR-211 locking is enforced at the service layer
 * with `SELECT ... FOR UPDATE` on the covered earning rows, not here.
 */
@Entity('marketplace_payout_requests')
@Index('IDX_mp_payouts_queue', ['status', 'requested_at'])
@Index('IDX_mp_payouts_instructor', ['instructor_id', 'status'])
@Index('UQ_mp_payout_requests_number', ['request_number'], { unique: true })
@Index('UQ_mp_payout_requests_idempotency', ['idempotency_key'], { unique: true })
@Check('CHK_mp_payouts_amount_positive', '"amount_minor" > 0')
@Check('CHK_mp_payouts_paid_reference', '"status" <> \'paid\' OR "payout_reference" IS NOT NULL')
@Check(
  'CHK_mp_payouts_reject_reason',
  '"status" NOT IN (\'rejected\',\'failed\') OR "reason" IS NOT NULL',
)
export class MarketplacePayoutRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 40, name: 'request_number' })
  request_number!: string;

  @Column({ type: 'uuid', name: 'instructor_id' })
  instructor_id!: string;

  @ManyToOne(() => MarketplaceInstructor, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'instructor_id' })
  instructor!: MarketplaceInstructor;

  @Column({ type: 'uuid', name: 'payout_account_id' })
  payout_account_id!: string;

  @ManyToOne(() => MarketplacePayoutAccount, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'payout_account_id' })
  payout_account!: MarketplacePayoutAccount;

  @Column({ type: 'bigint', name: 'amount_minor', transformer: minorUnitsTransformer })
  amount_minor!: number;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ type: 'varchar', length: 20, default: PayoutRequestStatus.REQUESTED })
  status!: PayoutRequestStatus;

  @Column({ type: 'varchar', length: 180, name: 'idempotency_key' })
  idempotency_key!: string;

  @Column({ type: 'varchar', length: 180, nullable: true, name: 'payout_reference' })
  payout_reference!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'decided_by' })
  decided_by!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'timestamptz', name: 'requested_at', default: () => 'now()' })
  requested_at!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'approved_at' })
  approved_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'processing_at' })
  processing_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'paid_at' })
  paid_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'failed_at' })
  failed_at!: Date | null;
}
