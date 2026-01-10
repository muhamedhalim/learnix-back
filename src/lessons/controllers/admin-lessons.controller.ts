import {
  Controller,
  Get,
  Delete,
  Param,
  Query,
  ParseUUIDPipe,
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
import { LessonsService } from '../lessons.service';
import { LessonFilterDto } from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

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
  async findAll(@Query() filter: LessonFilterDto) {
    return this.lessonsService.findAll(filter);
  }

  /**
   * Get a single lesson by ID
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get lesson by ID',
    description:
      'Returns detailed information about a lesson including teacher and subject. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Lesson ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lesson details retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.lessonsService.findOne(id);
  }

  /**
   * Get lesson statistics
   */
  @Get(':id/stats')
  @ApiOperation({
    summary: 'Get lesson stats',
    description:
      'Returns statistics for a lesson including purchase count and revenue. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Lesson ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lesson stats retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  async getStats(@Param('id', ParseUUIDPipe) id: string) {
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
  @ApiParam({ name: 'id', description: 'Lesson ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lesson deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    await this.lessonsService.adminDelete(id);
    return {
      message: 'Lesson deleted successfully',
    };
  }
}
