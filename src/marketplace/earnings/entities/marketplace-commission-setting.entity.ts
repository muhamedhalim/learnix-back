import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { MarketplaceCommissionScope } from '../../common/enums';

/**
 * Append-only commission history (FR-136): a rate change inserts a row and
 * stamps `superseded_at` on the prior one.
 */
@Entity('marketplace_commission_settings')
@Index('IDX_mp_commission_scope_effective', ['scope', 'scope_ref_id', 'effective_from'])
@Check('CHK_mp_commission_rate_range', '"rate_bps" BETWEEN 0 AND 10000')
export class MarketplaceCommissionSetting {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 20, default: MarketplaceCommissionScope.PLATFORM })
  scope!: MarketplaceCommissionScope;

  @Column({ type: 'uuid', nullable: true, name: 'scope_ref_id' })
  scope_ref_id!: string | null;

  @Column({ type: 'int', name: 'rate_bps' })
  rate_bps!: number;

  /** NULL = all currencies. */
  @Column({ type: 'char', length: 3, nullable: true })
  currency!: string | null;

  @Column({ type: 'timestamptz', name: 'effective_from', default: () => 'now()' })
  effective_from!: Date;

  @Column({ type: 'uuid', name: 'created_by' })
  created_by!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'superseded_at' })
  superseded_at!: Date | null;
}
