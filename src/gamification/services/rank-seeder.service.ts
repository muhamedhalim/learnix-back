import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { RankTier } from '../entities';
import { seedRankTiers } from '../../database/system-seed';

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
    const seeded = await seedRankTiers(this.ranks.manager);
    this.logger.log(`Seeded ${String(seeded)} rank tiers`);
  }
}
