import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { RankTier } from '../entities';

/**
 * Resolves a student's visual rank tier from their rating + XP. Tiers are
 * cached in memory (short TTL) since the ladder changes rarely; the leaderboard
 * and every solve consult this, so a per-call DB read would be wasteful.
 */
@Injectable()
export class RankService {
  private cache: RankTier[] | null = null;
  private cachedAt = 0;
  private static readonly TTL_MS = 60_000;

  constructor(
    @InjectRepository(RankTier)
    private readonly ranks: Repository<RankTier>,
  ) {}

  /** The full ladder, ascending by threshold. */
  public async ladder(): Promise<RankTier[]> {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < RankService.TTL_MS) return this.cache;
    this.cache = await this.ranks.find({ order: { sort_order: 'ASC', id: 'ASC' }, take: 100 });
    this.cachedAt = now;
    return this.cache;
  }

  /** Highest tier whose BOTH thresholds (rating AND xp) the student meets. */
  public async resolveTier(rating: number, xp: number): Promise<RankTier | null> {
    const ladder = await this.ladder();
    let current: RankTier | null = null;
    for (const tier of ladder) {
      if (rating >= tier.min_rating && xp >= tier.min_xp) current = tier;
    }
    return current ?? ladder[0] ?? null;
  }

  /** Invalidate the cache after an admin edits the ladder. */
  public invalidate(): void {
    this.cache = null;
  }
}
