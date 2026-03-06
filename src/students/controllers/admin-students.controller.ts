import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import {
  ApproveStudentDto,
  RejectStudentDto,
  StudentFilterDto,
  UpdateGradeLevelDto,
} from '../dto';
import { StudentsService } from '../students.service';

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
  public async findAll(@Query() filter: StudentFilterDto): Promise<unknown> {
    return await this.studentsService.findAllStudents(filter);
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
  public async findPending(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<unknown> {
    return await this.studentsService.findPendingStudents(
      page ?? 1,
      limit ?? 20,
    );
  }

  /**
   * Get a single student by ID
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

  /**
   * Get student statistics
   */
  @Get(':id/stats')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Student not found',
  })
  public async getStats(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ stats: unknown }> {
    const stats = await this.studentsService.getStudentStats(id);
    return {
      stats,
    };
  }

  /**
   * Approve a pending student
   */
  @Post(':id/approve')
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Student is already approved',
  })
  public async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() approveDto: ApproveStudentDto,
  ): Promise<{ message: string; student: unknown }> {
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
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Rejection reason is required',
  })
  public async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() rejectDto: RejectStudentDto,
  ): Promise<{ message: string; student: unknown }> {
    const student = await this.studentsService.rejectStudent(id, rejectDto);
    return {
      message: 'Student rejected successfully',
      student,
    };
  }

  /**
   * Update student's grade level
   */
  @Patch(':id/grade-level')
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid grade level',
  })
  public async updateGradeLevel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateGradeLevelDto,
  ): Promise<{ message: string; student: unknown }> {
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
