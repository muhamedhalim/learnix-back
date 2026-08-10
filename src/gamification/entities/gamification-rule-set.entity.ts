import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { Difficulty } from '../../exams/entities/difficulty.enum';
import type { ComboBonusRule, StreakMilestoneRule } from '../logic/xp-rules';

export type { ComboBonusRule, StreakMilestoneRule };

/**
 * DEF-018: one immutable, versioned snapshot of the platform's global XP
 * economy (base XP by difficulty, combo bonuses, streak bonuses). Content
 * columns are never updated after creation — only `enabled` is, a narrow,
 * audited rollback switch. To change scoring, an admin creates a NEW row
 * with a later `version_number`/`effective_from`; every `xp_events` amount
 * was already computed and stored at award time using whatever ruleset was
 * active then, so past awards never move when a later version is created.
 * `GamificationRulesService.resolveCurrent()` resolves the active row and
 * falls back to the original `gamification.constants.ts` values when none
 * exists yet, so default behavior is provably unchanged until an admin acts.
 */
@Entity('gamification_rule_sets')
@Index('IDX_gamification_rule_sets_current', ['enabled', 'effective_from'])
export class GamificationRuleSet {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'int', name: 'version_number', unique: true })
  version_number!: number;

  @Column({ type: 'jsonb', name: 'xp_base_by_difficulty' })
  xp_base_by_difficulty!: Record<Difficulty, number>;

  @Column({ type: 'jsonb', name: 'combo_bonuses' })
  combo_bonuses!: ComboBonusRule[];

  @Column({ type: 'int', name: 'streak_daily_bonus' })
  streak_daily_bonus!: number;

  @Column({ type: 'jsonb', name: 'streak_milestones' })
  streak_milestones!: StreakMilestoneRule[];

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'timestamptz', name: 'effective_from' })
  effective_from!: Date;

  /** Admin who created this version. Plain id, no relation — audit-only. */
  @Column({ type: 'uuid', name: 'created_by', nullable: true })
  created_by!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;
}
