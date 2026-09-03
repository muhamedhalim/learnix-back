import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { PublicCategory } from '../categories-read.service';
import { CategoriesReadService } from '../categories-read.service';

/** Contracts §1 — no auth. FR-085. */
@ApiTags('Marketplace / Public')
@Controller('marketplace/categories')
export class PublicCategoriesController {
  constructor(private readonly categories: CategoriesReadService) {}

  @Get()
  @ApiOperation({ summary: 'Taxonomy with published course counts (FR-085)' })
  public async list(): Promise<PublicCategory[]> {
    return this.categories.listActive();
  }
}
