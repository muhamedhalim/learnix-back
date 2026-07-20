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

import { Pagination20Dto } from '../../common/dto/pagination.dto';
import { PublicTeacherFilterDto } from '../dto';
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
      'Returns a paginated list of approved teachers. Supports search by public display name, filtering by subject, sorting by rating/name/date.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by public display name',
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
  public async findAll(
    @Query() filter: PublicTeacherFilterDto,
  ): Promise<unknown> {
    // Public endpoint: only approved teachers, sanitized projection (no PII).
    return await this.teachersService.findApprovedTeachersPublic(filter);
  }

  /**
   * Get a single approved teacher by ID
   */
  @Get(':id')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Teacher not found',
  })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    // Public endpoint: only approved teachers, sanitized projection (no PII).
    return await this.teachersService.findApprovedTeacherByIdPublic(id);
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
    @Query() pagination: Pagination20Dto,
  ): Promise<unknown> {
    // Public endpoint: sanitized projection (no PII).
    return await this.teachersService.findApprovedTeachersPublic({
      subjectId,
      page: pagination.page,
      limit: pagination.limit,
    });
  }
}
