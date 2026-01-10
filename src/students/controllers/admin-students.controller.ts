import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpStatus,
  HttpCode,
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
import { StudentsService } from '../students.service';
import {
  ApproveStudentDto,
  RejectStudentDto,
  UpdateGradeLevelDto,
  StudentFilterDto,
} from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('Admin - Students')
@Controller('admin/students')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminStudentsController {
  constructor(private readonly studentsService: StudentsService) {}

  /**
   * Get all students with optional filtering
   * Admin can see all students regardless of status
   */
  @Get()
  @ApiOperation({
    summary: 'Get all students',
    description:
      'Returns a paginated list of all students. Admin can filter by status (pending, approved, rejected), grade level, search, and sort.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by name or email',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'approved', 'rejected'],
    description: 'Filter by approval status',
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
    description: 'List of students with pagination meta',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not authorized (admin only)',
  })
  async findAll(@Query() filter: StudentFilterDto) {
    return this.studentsService.findAllStudents(filter);
  }

  /**
   * Get pending students (awaiting approval)
   */
  @Get('pending')
  @ApiOperation({
    summary: 'Get pending students',
    description:
      'Returns a paginated list of students awaiting approval. Admin only.',
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
    description: 'List of pending students',
  })
  async findPending(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.studentsService.findPendingStudents(page || 1, limit || 20);
  }

  /**
   * Get a single student by ID
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get student by ID',
    description:
      'Returns detailed information about a student including user details and notification settings. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Student profile ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Student details retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Student not found',
  })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.studentsService.findStudentById(id);
  }

  /**
   * Get student statistics
   */
  @Get(':id/stats')
  @ApiOperation({
    summary: 'Get student stats',
    description:
      'Returns statistics for a student including lessons completed, exams taken, and average score. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Student profile ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Student stats retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Student not found',
  })
  async getStats(@Param('id', ParseUUIDPipe) id: string) {
    const stats = await this.studentsService.getStudentStats(id);
    return {
      stats,
    };
  }

  /**
   * Approve a pending student
   */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a student',
    description:
      'Approves a pending student, allowing them to purchase lessons and take exams. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Student profile ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Student approved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Student not found',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Student is already approved',
  })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() approveDto: ApproveStudentDto,
  ) {
    const student = await this.studentsService.approveStudent(
      id,
      approveDto.notes,
    );
    return {
      message: 'Student approved successfully',
      student,
    };
  }

  /**
   * Reject a pending student
   */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a student',
    description:
      'Rejects a pending or approved student with a reason. Rejected students cannot purchase lessons or take exams. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Student profile ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Student rejected successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Student not found',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Student is already rejected',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Rejection reason is required',
  })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() rejectDto: RejectStudentDto,
  ) {
    const student = await this.studentsService.rejectStudent(id, rejectDto);
    return {
      message: 'Student rejected successfully',
      student,
    };
  }

  /**
   * Update student's grade level
   */
  @Put(':id/grade-level')
  @ApiOperation({
    summary: 'Update student grade level',
    description:
      "Updates a student's grade level. Useful for advancing students to the next grade. Admin only.",
  })
  @ApiParam({ name: 'id', description: 'Student profile ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Grade level updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Student not found',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid grade level',
  })
  async updateGradeLevel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateGradeLevelDto,
  ) {
    const student = await this.studentsService.updateGradeLevel(
      id,
      updateDto.grade_level,
    );
    return {
      message: 'Grade level updated successfully',
      student,
    };
  }
}
