import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { ApplicationCacheService } from '../../common/cache/application-cache.service';
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

/** Public gamification reads are anonymous and caller-independent, so one shared entry is safe. */
const PUBLIC_GAMIFICATION_CACHE_TTL_MS = 60_000;

/**
 * Public, UNAUTHENTICATED gamification surface: the leaderboards and student
 * profiles anyone can view without an account. Read-only GETs; no answer keys
 * or PII are exposed. Rate-limited by the global throttler.
 *
 * The profile and leaderboard are cached in family `gamification_public`
 * (scope `public`). Every writer of what they read invalidates that family: the
 * practice routes (declared), `GamificationService.ensureProfile` (on insert) and
 * the streak sweep (service level), and every undeclared HTTP route through the
 * global fallback (profile privacy toggle, user update/delete, question and rank
 * tier edits). Errors (404 for an unknown or private profile, 400 for a missing
 * scope filter) are thrown inside the compute and are therefore never cached.
 */
@ApiTags('Gamification - Public')
@Controller()
@Throttle({ default: THROTTLE.GLOBAL })
export class GamificationPublicController {
  constructor(
    private readonly leaderboard: LeaderboardService,
    private readonly ranks: RankService,
    private readonly profiles: PublicProfileService,
    private readonly applicationCache: ApplicationCacheService,
  ) {}

  @Get('leaderboard')
  @ApiOperation({ summary: 'Public leaderboard (scope + window + metric)' })
  public async getLeaderboard(@Query() query: LeaderboardQueryDto) {
    return await this.applicationCache.getOrCompute(
      {
        family: 'gamification_public',
        endpoint: 'gamification.leaderboard',
        scope: 'public',
        // Every validated dimension of the query, as a plain object so key order and
        // omitted values never fragment or collide entries. The values are matched
        // exactly by the queries (no case folding), so they are used exactly.
        parts: [
          {
            scope: query.scope,
            window: query.window,
            metric: query.metric,
            subject_id: query.subject_id,
            governorate: query.governorate,
            page: query.page,
            limit: query.limit,
          },
        ],
        ttlMs: PUBLIC_GAMIFICATION_CACHE_TTL_MS,
      },
      async () => await this.leaderboard.getLeaderboard(query),
    );
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
    return await this.applicationCache.getOrCompute(
      {
        family: 'gamification_public',
        endpoint: 'gamification.public-profile',
        scope: 'public',
        // `users.username` is a plain (case-sensitive) unique column and the lookup is an
        // exact match, so the username is used exactly: folding case would let two
        // different users share one entry.
        parts: [username],
        ttlMs: PUBLIC_GAMIFICATION_CACHE_TTL_MS,
      },
      async () => await this.profiles.getByUsername(username),
    );
  }
}
