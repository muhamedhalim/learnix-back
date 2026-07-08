import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { THROTTLE } from '../../common/constants';
import {
  LeaderboardMetric,
  LeaderboardQueryDto,
  LeaderboardScope,
  LeaderboardWindow,
} from '../dto/leaderboard-query.dto';
import { LeaderboardService } from '../services/leaderboard.service';
import { PublicProfileService } from '../services/public-profile.service';
import { RankService } from '../services/rank.service';

/**
 * Public, UNAUTHENTICATED gamification surface: the leaderboards and student
 * profiles anyone can view without an account. Read-only GETs; no answer keys
 * or PII are exposed. Rate-limited by the global throttler.
 */
@ApiTags('Gamification - Public')
@Controller()
@Throttle({ default: THROTTLE.GLOBAL })
export class GamificationPublicController {
  constructor(
    private readonly leaderboard: LeaderboardService,
    private readonly ranks: RankService,
    private readonly profiles: PublicProfileService,
  ) {}

  @Get('leaderboard')
  @ApiOperation({ summary: 'Public leaderboard (scope + window + metric)' })
  public async getLeaderboard(@Query() query: LeaderboardQueryDto) {
    return this.leaderboard.getLeaderboard(query);
  }

  @Get('leaderboard/scopes')
  @ApiOperation({ summary: 'Available leaderboard scopes / windows / metrics' })
  public getScopes() {
    return {
      scopes: Object.values(LeaderboardScope),
      windows: Object.values(LeaderboardWindow),
      metrics: Object.values(LeaderboardMetric),
    };
  }

  @Get('ranks')
  @ApiOperation({ summary: 'The rank-tier ladder (Bronze → Legend)' })
  public async getRanks() {
    const ladder = await this.ranks.ladder();
    return {
      ranks: ladder.map((t) => ({
        slug: t.slug,
        name: t.name,
        icon_key: t.icon_key,
        color: t.color,
        min_rating: t.min_rating,
        min_xp: t.min_xp,
        order: t.sort_order,
      })),
    };
  }

  @Get('u/:username')
  @ApiOperation({ summary: 'Public student profile' })
  public async getProfile(@Param('username') username: string) {
    return this.profiles.getByUsername(username);
  }
}
