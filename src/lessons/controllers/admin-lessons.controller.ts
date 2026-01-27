import {
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { LessonFilterDto } from '../dto';
import { LessonsService } from '../lessons.service';

@ApiTags('Admin - Lessons')
@Controller('admin/lessons')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminLessonsController {
  constructor(private readonly lessonsService: LessonsService) {}

  /**
   * Get all lessons with filtering
   * Admin can see all lessons with full filtering options
   */
  @Get()
  @ApiOperation({
    summary: 'Get all lessons',
    description:
      'Returns a paginated list of all lessons with full filtering options. Admin only.',
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
    name: 'subject_id',
    required: false,
    type: Number,
    description: 'Filter by subject ID',
  })
  @ApiQuery({
    name: 'is_group',
    required: false,
    type: Boolean,
    description: 'Filter by group lessons',
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
    enum: ['price', 'title', 'created_at', 'students_count'],
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
    description: 'List of all lessons',
  })
  public async findAll(@Query() filter: LessonFilterDto): Promise<unknown> {
    return await this.lessonsService.findAll(filter);
  }

  /**
   * Get a single lesson by ID
   */
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return await this.lessonsService.findOne(id);
  }

  /**
   * Get lesson statistics
   */
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  public async getStats(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    const stats = await this.lessonsService.getLessonStats(id);
    return {
      stats,
    };
  }

  /**
   * Force delete a lesson (admin override)
   */
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete lesson (admin)',
    description:
      'Force deletes any lesson regardless of owner. Use with caution. Admin only.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  public async delete(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    await this.lessonsService.adminDelete(id);
    return {
      message: 'Lesson deleted successfully',
    };
  }
}
