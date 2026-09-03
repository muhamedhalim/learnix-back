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
import { User } from '../../../users/entities/user.entity';
import { MarketplaceCourse, MarketplaceCourseVersion } from '../../catalog/entities';
import { MarketplaceCommissionScope, MarketplaceOrderStatus } from '../../common/enums';
import { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';

/**
 * The marketplace's own commercial record (D1) — separate from `orders`.
 * `CHK_mp_orders_split` is the database-level guarantee that commission +
 * instructor earning always reconciles to the net amount (FR-130, FR-327).
 */
@Entity('marketplace_orders')
@Index('UQ_mp_orders_open_per_course', ['learner_id', 'course_id'], {
  unique: true,
  where: "\"status\" IN ('awaiting_payment','paid')",
})
@Index('IDX_mp_orders_learner_status', ['learner_id', 'status'])
@Index('IDX_mp_orders_instructor_paid', ['instructor_id', 'paid_at'])
@Index('IDX_mp_orders_revenue', ['currency', 'paid_at'], { where: '"is_zero_value" = false' })
@Index('UQ_mp_orders_order_number', ['order_number'], { unique: true })
@Check('CHK_mp_orders_amounts', '"net_amount_minor" = "gross_amount_minor" - "discount_amount_minor"')
@Check(
  'CHK_mp_orders_split',
  '"commission_amount_minor" + "instructor_earning_minor" = "net_amount_minor"',
)
@Check('CHK_mp_orders_zero_value', '"is_zero_value" = ("net_amount_minor" = 0)')
@Check(
  'CHK_mp_orders_nonneg',
  '"gross_amount_minor" >= 0 AND "discount_amount_minor" >= 0 AND "net_amount_minor" >= 0 AND "commission_amount_minor" >= 0 AND "instructor_earning_minor" >= 0',
)
export class MarketplaceOrder {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 40, name: 'order_number' })
  order_number!: string;

  @Column({ type: 'uuid', name: 'learner_id' })
  learner_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'learner_id' })
  learner!: User;

  @Column({ type: 'uuid', name: 'course_id' })
  course_id!: string;

  @ManyToOne(() => MarketplaceCourse, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'course_id' })
  course!: MarketplaceCourse;

  @Column({ type: 'uuid', name: 'course_version_id' })
  course_version_id!: string;

  @ManyToOne(() => MarketplaceCourseVersion, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'course_version_id' })
  course_version!: MarketplaceCourseVersion;

  @Column({ type: 'uuid', name: 'instructor_id' })
  instructor_id!: string;

  @ManyToOne(() => MarketplaceInstructor, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'instructor_id' })
  instructor!: MarketplaceInstructor;

  @Column({ type: 'bigint', name: 'gross_amount_minor', transformer: minorUnitsTransformer })
  gross_amount_minor!: number;

  /** Reserved, always 0 while FR-109 stands. */
  @Column({ type: 'bigint', default: 0, name: 'discount_amount_minor', transformer: minorUnitsTransformer })
  discount_amount_minor!: number;

  @Column({ type: 'bigint', name: 'net_amount_minor', transformer: minorUnitsTransformer })
  net_amount_minor!: number;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  /** Snapshot (FR-134) — later rate changes never alter this order. */
  @Column({ type: 'int', name: 'commission_bps' })
  commission_bps!: number;

  @Column({ type: 'varchar', length: 20, default: MarketplaceCommissionScope.PLATFORM, name: 'commission_scope' })
  commission_scope!: MarketplaceCommissionScope;

  @Column({ type: 'bigint', name: 'commission_amount_minor', transformer: minorUnitsTransformer })
  commission_amount_minor!: number;

  @Column({ type: 'bigint', name: 'instructor_earning_minor', transformer: minorUnitsTransformer })
  instructor_earning_minor!: number;

  /** Snapshot (FR-180) — later policy changes never alter this order. */
  @Column({ type: 'int', name: 'refund_window_days' })
  refund_window_days!: number;

  @Column({ type: 'int', name: 'consumption_cap_bps' })
  consumption_cap_bps!: number;

  @Column({ type: 'varchar', length: 30, default: MarketplaceOrderStatus.AWAITING_PAYMENT })
  status!: MarketplaceOrderStatus;

  /** The discriminator every revenue query filters on (FR-115). */
  @Column({ type: 'boolean', default: false, name: 'is_zero_value' })
  is_zero_value!: boolean;

  @Column({ type: 'uuid', nullable: true, name: 'payment_id' })
  payment_id!: string | null;

  @Column({ type: 'varchar', length: 255, name: 'course_title_snapshot' })
  course_title_snapshot!: string;

  @Column({ type: 'varchar', length: 255, name: 'instructor_name_snapshot' })
  instructor_name_snapshot!: string;

  @Column({ type: 'timestamptz', nullable: true, name: 'paid_at' })
  paid_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'expires_at' })
  expires_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'cancelled_at' })
  cancelled_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'refunded_at' })
  refunded_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
