import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { RANK_TIER_SEEDS } from '../gamification.constants';
import { RankTier } from '../entities';

/**
 * Seeds the rank-tier ladder on boot if the table is empty. Idempotent — a
 * populated table (e.g. admin-edited later) is left untouched.
 */
@Injectable()
export class RankSeederService implements OnModuleInit {
  private readonly logger = new Logger(RankSeederService.name);

  constructor(
    @InjectRepository(RankTier)
    private readonly ranks: Repository<RankTier>,
  ) {}

  public async onModuleInit(): Promise<void> {
    const count = await this.ranks.count();
    if (count > 0) return;
    await this.ranks.save(
      RANK_TIER_SEEDS.map((seed) =>
        this.ranks.create({
          slug: seed.slug,
          name: seed.name,
          icon_key: seed.icon_key,
          color: seed.color,
          min_rating: seed.min_rating,
          min_xp: seed.min_xp,
          sort_order: seed.order,
        }),
      ),
    );
    this.logger.log(`Seeded ${String(RANK_TIER_SEEDS.length)} rank tiers`);
  }
}
