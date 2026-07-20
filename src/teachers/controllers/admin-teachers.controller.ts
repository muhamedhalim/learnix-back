import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Pagination20Dto } from '../../common/dto/pagination.dto';
import {
  ApproveTeacherDto,
  AssignSubjectsDto,
  PromoteTeacherDto,
  RejectTeacherDto,
  TeacherFilterDto,
} from '../dto';
import { TeachersService } from '../teachers.service';

@ApiTags('Admin - Teachers')
@Controller('admin/teachers')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminTeachersController {
  constructor(private readonly teachersService: TeachersService) {}

  /**
   * Get all teachers with optional filtering
   * Admin can see all teachers regardless of status
   */
  @Get()
  @ApiOperation({
    summary: 'Get all teachers',
    description:
      'Returns a paginated list of all teachers. Admin can filter by status (pending, approved, rejected), search, and sort.',
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
    description: 'List of teachers with pagination meta',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not authorized (admin only)',
  })
  public async findAll(@Query() filter: TeacherFilterDto): Promise<unknown> {
    return await this.teachersService.findAllTeachers(filter);
  }

  /**
   * Get pending teachers (awaiting approval)
   */
  @Get('pending')
  @ApiOperation({
    summary: 'Get pending teachers',
    description:
      'Returns a paginated list of teachers awaiting approval. Admin only.',
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
    description: 'List of pending teachers',
  })
  public async findPending(
    @Query() pagination: Pagination20Dto,
  ): Promise<unknown> {
    return await this.teachersService.findPendingTeachers(
      pagination.page,
      pagination.limit,
    );
  }

  /**
   * Get a single teacher by ID
   */
  @Get(':id')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Teacher not found',
  })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return await this.teachersService.findTeacherById(id);
  }

  /**
   * Get teacher statistics
   */
  @Get(':id/stats')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Teacher not found',
  })
  public async getStats(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    const stats = await this.teachersService.getTeacherStats(id);
    return {
      stats,
    };
  }

  /**
   * Promote an existing student account into a teacher
   */
  @Post('promote')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Promote a student to teacher',
    description:
      'Converts an existing STUDENT account into a TEACHER: changes the role, marks the account approved, removes the student profile, and creates a teacher profile. Admin only.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Student promoted to teacher successfully',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'User not found' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Account is not a student',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'User is already a teacher',
  })
  public async promote(@Body() dto: PromoteTeacherDto): Promise<unknown> {
    const teacher = await this.teachersService.promoteStudentToTeacher(
      dto.user_id,
      dto,
    );
    return {
      message: 'Student promoted to teacher successfully',
      data: teacher,
    };
  }

  /**
   * Approve a pending teacher
   */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a teacher',
    description:
      'Approves a pending teacher, allowing them to create lessons and be visible in public listings. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Teacher profile ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Teacher approved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Teacher not found',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Teacher is already approved',
  })
  public async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() approveDto: ApproveTeacherDto,
  ): Promise<unknown> {
    const teacher = await this.teachersService.approveTeacher(
      id,
      approveDto.notes,
    );
    return {
      message: 'Teacher approved successfully',
      teacher,
    };
  }

  /**
   * Reject a pending teacher
   */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Rejection reason is required',
  })
  public async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() rejectDto: RejectTeacherDto,
  ): Promise<unknown> {
    const teacher = await this.teachersService.rejectTeacher(id, rejectDto);
    return {
      message: 'Teacher rejected successfully',
      teacher,
    };
  }

  /**
   * Assign subjects to a teacher
   */
  @Post(':id/subjects')
  @HttpCode(HttpStatus.OK)
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'One or more subjects not found',
  })
  public async assignSubjects(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() assignDto: AssignSubjectsDto,
  ): Promise<unknown> {
    const teacher = await this.teachersService.assignSubjects(id, assignDto);
    return {
      message: 'Subjects assigned successfully',
      teacher,
    };
  }
}
