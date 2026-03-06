import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { LessonFilterDto } from '../dto';
import { LessonsService } from '../lessons.service';

@ApiTags('Lessons')
@Controller('lessons')
export class LessonsController {
  constructor(private readonly lessonsService: LessonsService) {}

  /**
   * Get all lessons (public listing)
   * Supports search, filtering, sorting, and pagination
   */
  @Get()
  @ApiOperation({
    summary: 'Get all lessons',
    description:
      'Returns a paginated list of lessons. Supports search by title, filtering by teacher/subject/price, sorting by price/title/date/popularity.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by lesson title',
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
    description: 'Items per page (default: 20, max: 100)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of lessons with pagination meta',
  })
  public async findAll(@Query() filter: LessonFilterDto): Promise<unknown> {
    return await this.lessonsService.findAll(filter);
  }

  /**
   * Get a single lesson by ID
   */
  @Get(':id')
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
   * Get lessons by teacher
   */
  @Get('teacher/:teacherId')
  @ApiOperation({
    summary: 'Get lessons by teacher',
    description: 'Returns all lessons created by a specific teacher.',
  })
  @ApiParam({ name: 'teacherId', description: 'Teacher user ID' })
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
    description: 'List of lessons by teacher',
  })
  public async findByTeacher(
    @Param('teacherId', ParseUUIDPipe) teacherId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<unknown> {
    return await this.lessonsService.findByTeacher(teacherId, {
      page: page ?? 1,
      limit: limit ?? 20,
    });
  }

  /**
   * Get lessons by subject
   */
  @Get('subject/:subjectId')
  @ApiOperation({
    summary: 'Get lessons by subject',
    description: 'Returns all lessons for a specific subject.',
  })
  @ApiParam({ name: 'subjectId', description: 'Subject ID' })
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
    description: 'List of lessons by subject',
  })
  public async findBySubject(
    @Param('subjectId', ParseUUIDPipe) subjectId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<unknown> {
    return await this.lessonsService.findBySubject(subjectId, {
      page: page ?? 1,
      limit: limit ?? 20,
    });
  }
}
