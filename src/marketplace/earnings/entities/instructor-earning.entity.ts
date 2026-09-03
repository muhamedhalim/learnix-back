import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { minorUnitsTransformer } from '../../../payments/money.util';
import { MarketplaceOrder } from '../../commerce/entities';
import { InstructorEarningStatus } from '../../common/enums';
import { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';

/** The revenue attributable to an instructor from one paid order (FR-141 – FR-156). Never created for a zero-value order. */
@Entity('marketplace_instructor_earnings')
@Index('IDX_mp_earnings_clearance', ['status', 'available_at'], {
  where: "\"status\" = 'refund_clearance'",
})
@Index('IDX_mp_earnings_balance', ['instructor_id', 'currency', 'status'])
@Index('UQ_mp_earnings_order', ['order_id'], { unique: true })
@Check('CHK_mp_earnings_split', '"commission_amount_minor" + "net_amount_minor" = "gross_amount_minor"')
@Check('CHK_mp_earnings_amount_positive', '"gross_amount_minor" > 0')
export class InstructorEarning {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'instructor_id' })
  instructor_id!: string;

  @ManyToOne(() => MarketplaceInstructor, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'instructor_id' })
  instructor!: MarketplaceInstructor;

  @Column({ type: 'uuid', name: 'order_id' })
  order_id!: string;

  @ManyToOne(() => MarketplaceOrder, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order!: MarketplaceOrder;

  @Column({ type: 'bigint', name: 'gross_amount_minor', transformer: minorUnitsTransformer })
  gross_amount_minor!: number;

  @Column({ type: 'bigint', name: 'commission_amount_minor', transformer: minorUnitsTransformer })
  commission_amount_minor!: number;

  @Column({ type: 'bigint', name: 'net_amount_minor', transformer: minorUnitsTransformer })
  net_amount_minor!: number;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ type: 'int', name: 'commission_bps' })
  commission_bps!: number;

  @Column({ type: 'varchar', length: 30, default: InstructorEarningStatus.PENDING_EARNINGS })
  status!: InstructorEarningStatus;

  /** The clearance date derived from the order's own snapshotted window (FR-146, FR-152). */
  @Column({ type: 'timestamptz', name: 'available_at' })
  available_at!: Date;

  @Column({ type: 'uuid', nullable: true, name: 'payout_request_id' })
  payout_request_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'reversed_at' })
  reversed_at!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'reversal_reason' })
  reversal_reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
