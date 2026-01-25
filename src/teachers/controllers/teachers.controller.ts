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

import { TeacherFilterDto } from '../dto';
import { TeachersService } from '../teachers.service';

@ApiTags('Teachers')
@Controller('teachers')
export class TeachersController {
  constructor(private readonly teachersService: TeachersService) {}

  /**
   * Get all approved teachers (public listing)
   * Supports search, filtering by subject, sorting, and pagination
   */
  @Get()
  @ApiOperation({
    summary: 'Get all approved teachers',
    description:
      'Returns a paginated list of approved teachers. Supports search by name/email, filtering by subject, sorting by rating/name/date.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by name or email',
  })
  @ApiQuery({
    name: 'subjectId',
    required: false,
    type: Number,
    description: 'Filter by subject ID',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['rating', 'name', 'created_at'],
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
    description: 'List of approved teachers with pagination meta',
  })
  public async findAll(@Query() filter: Omit<TeacherFilterDto, 'status'>): Promise<unknown> {
    // Public endpoint only shows approved teachers
    return this.teachersService.findApprovedTeachers(filter);
  }

  /**
   * Get a single approved teacher by ID
   */
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Teacher not found',
  })
  public async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.teachersService.findTeacherById(id);
  }

  /**
   * Get teachers by subject
   */
  @Get('by-subject/:subjectId')
  @ApiOperation({
    summary: 'Get teachers by subject',
    description: 'Returns all approved teachers who teach a specific subject.',
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
    description: 'List of teachers for the subject',
  })
  public async findBySubject(
    @Param('subjectId', ParseUUIDPipe) subjectId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<unknown> {
    return this.teachersService.findApprovedTeachers({
      subjectId,
      page: page ?? 1,
      limit: limit ?? 20,
    });
  }
}
