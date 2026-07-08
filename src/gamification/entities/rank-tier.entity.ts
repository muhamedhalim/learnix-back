import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { numericTransformer } from '../../exams/entities/numeric.transformer';

/**
 * A visual rank tier (Bronze → Legend). A student's current tier is the highest
 * tier whose `min_rating` AND `min_xp` they meet. Seeded from `RANK_TIER_SEEDS`;
 * admin-editable in a later milestone.
 */
@Entity('rank_tiers')
export class RankTier {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 50, unique: true })
  @Index('IDX_rank_tiers_slug')
  slug!: string;

  @Column({ type: 'varchar', length: 50 })
  name!: string;

  /** Icon identifier the frontend maps to an asset/emoji. */
  @Column({ type: 'varchar', length: 50, name: 'icon_key' })
  icon_key!: string;

  /** Hex colour for the badge. */
  @Column({ type: 'varchar', length: 20 })
  color!: string;

  @Column({ type: 'numeric', precision: 8, scale: 2, name: 'min_rating', default: 0, transformer: numericTransformer })
  min_rating!: number;

  @Column({ type: 'bigint', name: 'min_xp', default: 0, transformer: numericTransformer })
  min_xp!: number;

  /** Display/threshold order, ascending (Bronze=1 … Legend=5). */
  @Column({ type: 'int', name: 'sort_order', default: 0 })
  sort_order!: number;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
