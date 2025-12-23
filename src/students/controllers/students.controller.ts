import {
  Controller,
  Get,
  Param,
  Query,
  ParseIntPipe,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { StudentsService } from '../students.service';
import { StudentFilterDto } from '../dto';

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
  async findAll(@Query() filter: Omit<StudentFilterDto, 'status'>) {
    // Public endpoint only shows approved students
    return this.studentsService.findApprovedStudents(filter);
  }

  /**
   * Get a single approved student by ID
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get student by ID',
    description: 'Returns a single approved student profile.',
  })
  @ApiParam({ name: 'id', description: 'Student profile ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Student profile retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Student not found',
  })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.studentsService.findStudentById(id);
  }
}
