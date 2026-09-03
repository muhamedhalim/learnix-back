import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CategoryService } from '../category.service';
import { CreateCategoryDto, UpdateCategoryDto } from '../dto/category.dto';
import type { MarketplaceCategory } from '../entities';

/** Contracts §5 — bilingual names required (FR-035); DELETE refused when referenced (FR-039). */
@ApiTags('Marketplace / Admin — Categories')
@Controller('marketplace/admin/categories')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminCategoriesController {
  constructor(private readonly categories: CategoryService) {}

  @Get()
  @ApiOperation({ summary: 'Every category, active and inactive (FR-035)' })
  public async list(): Promise<MarketplaceCategory[]> {
    return this.categories.listAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create a category or sub-category, at most two levels deep (FR-036)' })
  public async create(@Body() dto: CreateCategoryDto): Promise<MarketplaceCategory> {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit, reorder (display_order) or activate/deactivate a category (FR-035, FR-040)' })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<MarketplaceCategory> {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a category; refused with the referencing course count if any course is assigned (FR-039)' })
  public async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.categories.delete(id);
  }
}
