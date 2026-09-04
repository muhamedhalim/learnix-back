import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApplicationCacheService } from '../../../common/cache/application-cache.service';
import { biBody } from '../../../i18n/error-translator.util';
import type { PublicInstructorProfile } from '../public-instructor-profile.service';
import { PublicInstructorProfileService } from '../public-instructor-profile.service';

/** FR-330 — matches the rest of the public catalogue surface's TTL. */
const PUBLIC_CATALOG_CACHE_TTL_MS = 60_000;

/**
 * Contracts §1 — no auth. FR-032: a suspended, withdrawn or nonexistent
 * instructor all resolve to the same 404, never a 403 that would leak
 * which case it was.
 */
@ApiTags('Marketplace / Public')
@Controller('marketplace/instructors')
export class PublicInstructorController {
  constructor(
    private readonly profiles: PublicInstructorProfileService,
    private readonly cache: ApplicationCacheService,
  ) {}

  @Get(':slug')
  @ApiOperation({ summary: 'Public instructor profile with published courses (FR-026, FR-027)' })
  public async getProfile(@Param('slug') slug: string): Promise<PublicInstructorProfile> {
    // The not-found throw lives INSIDE `compute` — `getOrCompute` only
    // caches a successful resolution (`computeAndCache` calls
    // `cacheManager.set` strictly after `compute()` resolves, never on
    // rejection), so a 404 is always a fresh lookup, never "stuck" for 60s
    // after an instructor's profile actually becomes visible.
    return this.cache.getOrCompute(
      { family: 'marketplace_catalog', endpoint: 'instructor_profile', scope: 'public', parts: ['instructor_profile', slug], ttlMs: PUBLIC_CATALOG_CACHE_TTL_MS },
      async () => {
        const profile = await this.profiles.getBySlug(slug);
        if (!profile) {
          throw new NotFoundException(biBody('Instructor not found', 'المدرّب غير موجود'));
        }
        return profile;
      },
    );
  }
}
