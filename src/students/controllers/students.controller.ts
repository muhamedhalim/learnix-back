import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { StudentFilterDto } from '../dto';
import { StudentsService } from '../students.service';

@ApiTags('Students')
@Controller('students')
export class StudentsController {
  constructor(private readonly studentsService: StudentsService) {}

  /**
   * Get all approved students (public listing)
   * Supports search, filtering by grade, sorting, and pagination
   */
  @Get()
  @ApiOperation({
    summary: 'Get all approved students',
    description:
      'Returns a paginated list of approved students. Supports search by name/email, filtering by grade level, sorting by name/grade/date.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by name or email',
  })
  @ApiQuery({
    name: 'grade_level',
    required: false,
    description: 'Filter by grade level',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['name', 'grade', 'created_at'],
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
    description: 'List of approved students with pagination meta',
  })
  public async findAll(
    @Query() filter: Omit<StudentFilterDto, 'status'>,
  ): Promise<unknown> {
    // Public endpoint only shows approved students
    return await this.studentsService.findApprovedStudents(filter);
  }

  /**
   * Get a single approved student by ID
   */
  @Get(':id')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Student not found',
  })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return await this.studentsService.findStudentById(id);
  }
}
