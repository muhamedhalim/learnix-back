import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { Difficulty } from '../../exams/entities/difficulty.enum';
import { biBody } from '../../i18n/error-translator.util';
import { CreateGamificationRuleSetDto } from '../dto/gamification-rule-set.dto';
import { GamificationRuleSet } from '../entities/gamification-rule-set.entity';
import {
  COMBO_BONUSES,
  STREAK_DAILY_BONUS,
  STREAK_MILESTONES,
  XP_BASE_BY_DIFFICULTY,
} from '../gamification.constants';
import type { ComboBonusRule, StreakMilestoneRule } from '../logic/xp-rules';

export interface ResolvedRuleSet {
  id: string | null;
  version_number: number | null;
  xp_base_by_difficulty: Record<Difficulty, number>;
  combo_bonuses: ComboBonusRule[];
  streak_daily_bonus: number;
  streak_milestones: StreakMilestoneRule[];
}

/**
 * Identical to `gamification.constants.ts` — the ruleset in effect until an
 * admin creates the first version, and forever after if every version is
 * disabled. Guarantees "existing XP rules remain unchanged by default".
 */
const DEFAULT_RULE_SET: ResolvedRuleSet = {
  id: null,
  version_number: null,
  xp_base_by_difficulty: XP_BASE_BY_DIFFICULTY,
  combo_bonuses: COMBO_BONUSES as unknown as ComboBonusRule[],
  streak_daily_bonus: STREAK_DAILY_BONUS,
  streak_milestones: STREAK_MILESTONES as unknown as StreakMilestoneRule[],
};

/**
 * DEF-018: resolves and manages the platform's versioned, admin-configurable
 * XP economy. A version's content columns are never updated after creation
 * (see `GamificationRuleSet`'s doc comment) — "editing" the rules always
 * means creating a new, later version via `create()`; `setEnabled()` is the
 * one narrow, audited exception (a rollback switch, not a content edit).
 * Cached the same way `RankService.ladder()` caches the rank ladder — both
 * are read on every `GamificationService.recordSolve`, so a short TTL trades
 * a little propagation delay for not hitting the DB on every practice answer.
 */
@Injectable()
export class GamificationRulesService {
  private cache: ResolvedRuleSet | null = null;
  private cachedAt = 0;
  private static readonly TTL_MS = 60_000;

  constructor(
    @InjectRepository(GamificationRuleSet)
    private readonly ruleSets: Repository<GamificationRuleSet>,
    private readonly dataSource: DataSource,
  ) {}

  /** The active ruleset: newest enabled version whose effective_from has passed. */
  public async resolveCurrent(manager?: EntityManager): Promise<ResolvedRuleSet> {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < GamificationRulesService.TTL_MS) return this.cache;
    const repo = manager ? manager.getRepository(GamificationRuleSet) : this.ruleSets;
    const row = await repo
      .createQueryBuilder('rule_set')
      .where('rule_set.enabled = true')
      .andWhere('rule_set.effective_from <= :now', { now: new Date() })
      .orderBy('rule_set.effective_from', 'DESC')
      .addOrderBy('rule_set.version_number', 'DESC')
      .getOne();
    this.cache = row ? this.toResolved(row) : DEFAULT_RULE_SET;
    this.cachedAt = now;
    return this.cache;
  }

  /** Full version history for the admin audit/history screen, newest first. */
  public async history(): Promise<GamificationRuleSet[]> {
    return this.ruleSets.find({ order: { version_number: 'DESC' } });
  }

  /** Create a new, later version. Never mutates an existing one. */
  public async create(dto: CreateGamificationRuleSetDto, adminId: string): Promise<GamificationRuleSet> {
    this.assertUniqueThresholds(dto.combo_bonuses.map((c) => c.at), 'combo_bonuses[].at');
    this.assertUniqueThresholds(dto.streak_milestones.map((s) => s.days), 'streak_milestones[].days');

    const created = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(GamificationRuleSet);
      // Lock the newest row (if any) so two concurrent admin creates can't
      // compute the same next version_number.
      const last = await repo
        .createQueryBuilder('rule_set')
        .orderBy('rule_set.version_number', 'DESC')
        .setLock('pessimistic_write')
        .getOne();
      const nextVersion = (last?.version_number ?? 0) + 1;
      return repo.save(
        repo.create({
          version_number: nextVersion,
          xp_base_by_difficulty: {
            [Difficulty.EASY]: dto.xp_base_by_difficulty.easy,
            [Difficulty.MEDIUM]: dto.xp_base_by_difficulty.medium,
            [Difficulty.HARD]: dto.xp_base_by_difficulty.hard,
            [Difficulty.EXPERT]: dto.xp_base_by_difficulty.expert,
          } as Record<Difficulty, number>,
          combo_bonuses: dto.combo_bonuses,
          streak_daily_bonus: dto.streak_daily_bonus,
          streak_milestones: dto.streak_milestones,
          enabled: true,
          effective_from: dto.effective_from ? new Date(dto.effective_from) : new Date(),
          created_by: adminId,
          notes: dto.notes?.trim() || null,
        }),
      );
    });
    this.invalidate();
    return created;
  }

  /** Enable/disable a version — the one field that may change after creation. */
  public async setEnabled(id: string, enabled: boolean): Promise<GamificationRuleSet> {
    const ruleSet = await this.ruleSets.findOne({ where: { id } });
    if (!ruleSet) {
      throw new NotFoundException(biBody('Rule set version not found', 'إصدار مجموعة القواعد غير موجود'));
    }
    ruleSet.enabled = enabled;
    const saved = await this.ruleSets.save(ruleSet);
    this.invalidate();
    return saved;
  }

  public invalidate(): void {
    this.cache = null;
  }

  private toResolved(row: GamificationRuleSet): ResolvedRuleSet {
    return {
      id: row.id,
      version_number: row.version_number,
      xp_base_by_difficulty: row.xp_base_by_difficulty,
      combo_bonuses: row.combo_bonuses,
      streak_daily_bonus: row.streak_daily_bonus,
      streak_milestones: row.streak_milestones,
    };
  }

  private assertUniqueThresholds(values: number[], field: string): void {
    const seen = new Set<number>();
    for (const value of values) {
      if (seen.has(value)) {
        throw new BadRequestException(
          biBody(`Duplicate ${field} value: ${value}`, `قيمة مكررة في ${field}: ${value}`),
        );
      }
      seen.add(value);
    }
  }
}
