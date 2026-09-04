import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApplicationCacheService } from '../../../common/cache/application-cache.service';
import type { PublicCategory } from '../categories-read.service';
import { CategoriesReadService } from '../categories-read.service';

/** FR-330 — matches the rest of the public catalogue surface's TTL. */
const PUBLIC_CATALOG_CACHE_TTL_MS = 60_000;

/** Contracts §1 — no auth. FR-085. */
@ApiTags('Marketplace / Public')
@Controller('marketplace/categories')
export class PublicCategoriesController {
  constructor(
    private readonly categories: CategoriesReadService,
    private readonly cache: ApplicationCacheService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Taxonomy with published course counts (FR-085)' })
  public async list(): Promise<PublicCategory[]> {
    return this.cache.getOrCompute(
      { family: 'marketplace_catalog', endpoint: 'categories', scope: 'public', parts: ['categories'], ttlMs: PUBLIC_CATALOG_CACHE_TTL_MS },
      () => this.categories.listActive(),
    );
  }
}
