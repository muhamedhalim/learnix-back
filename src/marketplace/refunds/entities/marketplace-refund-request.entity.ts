import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../../users/entities/user.entity';
import { MarketplaceEnrollment, MarketplaceOrder } from '../../commerce/entities';
import { RefundRequestStatus } from '../../common/enums';

/** A learner's request to reverse a paid enrollment (FR-176 – FR-199). */
@Entity('marketplace_refund_requests')
@Index('UQ_mp_refunds_open_per_order', ['order_id'], {
  unique: true,
  where: "\"status\" IN ('requested','approved','processing')",
})
@Index('IDX_mp_refunds_queue', ['status', 'created_at'])
export class MarketplaceRefundRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'order_id' })
  order_id!: string;

  @ManyToOne(() => MarketplaceOrder, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order!: MarketplaceOrder;

  @Column({ type: 'uuid', name: 'enrollment_id' })
  enrollment_id!: string;

  @ManyToOne(() => MarketplaceEnrollment, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'enrollment_id' })
  enrollment!: MarketplaceEnrollment;

  @Column({ type: 'uuid', name: 'learner_id' })
  learner_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'learner_id' })
  learner!: User;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'varchar', length: 20, default: RefundRequestStatus.REQUESTED })
  status!: RefundRequestStatus;

  @Column({ type: 'boolean', default: false, name: 'is_discretionary' })
  is_discretionary!: boolean;

  /** FR-186 — refunds issued automatically by a permanent course removal. */
  @Column({ type: 'boolean', default: false, name: 'is_removal_driven' })
  is_removal_driven!: boolean;

  @Column({ type: 'int', name: 'elapsed_days_at_request' })
  elapsed_days_at_request!: number;

  @Column({ type: 'int', name: 'progress_bps_at_request' })
  progress_bps_at_request!: number;

  @Column({ type: 'int', nullable: true, name: 'progress_bps_at_processing' })
  progress_bps_at_processing!: number | null;

  @Column({ type: 'jsonb', default: () => "'{}'", name: 'eligibility_verdict' })
  eligibility_verdict!: Record<string, unknown>;

  @Column({ type: 'uuid', nullable: true, name: 'decided_by' })
  decided_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'decided_at' })
  decided_at!: Date | null;

  @Column({ type: 'varchar', length: 180, nullable: true, name: 'refund_reference' })
  refund_reference!: string | null;

  @Column({ type: 'text', nullable: true, name: 'failure_reason' })
  failure_reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
