import { Check, Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The currency registry (FR-325) — the single source for every precision,
 * price bound and payout floor, so none of them is ever hard-coded or
 * assumed. Rows are never deleted; a currency is retired by clearing
 * `is_enabled` so historical orders keep a resolvable precision.
 */
@Entity('marketplace_currencies')
@Check(
  'CHK_mp_currencies_bounds',
  '"min_price_minor" >= 0 AND "max_price_minor" > "min_price_minor" AND "min_payout_minor" > 0',
)
@Check('CHK_mp_currencies_exponent', '"minor_unit_exponent" BETWEEN 0 AND 4')
export class MarketplaceCurrency {
  @PrimaryColumn({ type: 'char', length: 3 })
  code!: string;

  @Column({ type: 'smallint', name: 'minor_unit_exponent' })
  minor_unit_exponent!: number;

  @Column({ type: 'boolean', default: false, name: 'is_enabled' })
  is_enabled!: boolean;

  @Column({ type: 'bigint', name: 'min_price_minor' })
  min_price_minor!: number;

  @Column({ type: 'bigint', name: 'max_price_minor' })
  max_price_minor!: number;

  @Column({ type: 'bigint', name: 'min_payout_minor' })
  min_payout_minor!: number;

  @Column({ type: 'uuid', nullable: true, name: 'updated_by' })
  updated_by!: string | null;

  @Column({ type: 'timestamptz', name: 'updated_at', default: () => 'now()' })
  updated_at!: Date;
}
