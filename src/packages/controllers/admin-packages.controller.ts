import {
  Controller,
  Get,
  Delete,
  Param,
  Query,
  ParseIntPipe,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { PackagesService } from '../packages.service';
import { PackageFilterDto } from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('Admin - Packages')
@Controller('admin/packages')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminPackagesController {
  constructor(private readonly packagesService: PackagesService) {}

  /**
   * Get all packages with filtering
   * Admin can see all packages with full filtering options
   */
  @Get()
  @ApiOperation({
    summary: 'Get all packages',
    description:
      'Returns a paginated list of all packages with full filtering options. Admin only.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by title',
  })
  @ApiQuery({
    name: 'teacher_id',
    required: false,
    type: Number,
    description: 'Filter by teacher ID',
  })
  @ApiQuery({
    name: 'is_active',
    required: false,
    type: Boolean,
    description: 'Filter by active status',
  })
  @ApiQuery({
    name: 'minPrice',
    required: false,
    type: Number,
    description: 'Minimum price filter',
  })
  @ApiQuery({
    name: 'maxPrice',
    required: false,
    type: Number,
    description: 'Maximum price filter',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['price', 'title', 'created_at', 'lessons_count'],
    description: 'Sort by field (default: created_at)',
  })
  @ApiQuery({
    name: 'order',
    required: false,
    enum: ['asc', 'desc'],
    description: 'Sort order (default: desc)',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default: 20)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of all packages',
  })
  async findAll(@Query() filter: PackageFilterDto) {
    return this.packagesService.findAll(filter);
  }

  /**
   * Get a single package by ID
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get package by ID',
    description:
      'Returns detailed information about a package including lessons. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Package ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Package details retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Package not found',
  })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.packagesService.findOne(id);
  }

  /**
   * Get package statistics
   */
  @Get(':id/stats')
  @ApiOperation({
    summary: 'Get package stats',
    description:
      'Returns statistics for a package including purchase count and revenue. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Package ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Package stats retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Package not found',
  })
  async getStats(@Param('id', ParseIntPipe) id: number) {
    const stats = await this.packagesService.getPackageStats(id);
    return {
      stats,
    };
  }

  /**
   * Force delete a package (admin override)
   */
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete package (admin)',
    description:
      'Force deletes any package regardless of owner. Use with caution. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Package ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Package deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Package not found',
  })
  async delete(@Param('id', ParseIntPipe) id: number) {
    await this.packagesService.adminDelete(id);
    return {
      message: 'Package deleted successfully',
    };
  }
}
