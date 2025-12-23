import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  ParseIntPipe,
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
import { TeachersService } from '../teachers.service';
import {
  ApproveTeacherDto,
  RejectTeacherDto,
  AssignSubjectsDto,
  TeacherFilterDto,
} from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

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
  async findAll(@Query() filter: TeacherFilterDto) {
    return this.teachersService.findAllTeachers(filter);
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
  async findPending(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.teachersService.findPendingTeachers(page || 1, limit || 20);
  }

  /**
   * Get a single teacher by ID
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get teacher by ID',
    description:
      'Returns detailed information about a teacher including user details, subjects, and rating. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Teacher profile ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Teacher details retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Teacher not found',
  })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.teachersService.findTeacherById(id);
  }

  /**
   * Get teacher statistics
   */
  @Get(':id/stats')
  @ApiOperation({
    summary: 'Get teacher stats',
    description:
      'Returns statistics for a teacher including lesson count, student count, and earnings. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Teacher profile ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Teacher stats retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Teacher not found',
  })
  async getStats(@Param('id', ParseIntPipe) id: number) {
    const stats = await this.teachersService.getTeacherStats(id);
    return {
      stats,
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
  async approve(
    @Param('id', ParseIntPipe) id: number,
    @Body() approveDto: ApproveTeacherDto,
  ) {
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
  @ApiOperation({
    summary: 'Reject a teacher',
    description:
      'Rejects a pending or approved teacher with a reason. Rejected teachers cannot create lessons. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Teacher profile ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Teacher rejected successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Teacher not found',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Teacher is already rejected',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Rejection reason is required',
  })
  async reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() rejectDto: RejectTeacherDto,
  ) {
    const teacher = await this.teachersService.rejectTeacher(id, rejectDto);
    return {
      message: 'Teacher rejected successfully',
      teacher,
    };
  }

  /**
   * Assign subjects to a teacher
   */
  @Put(':id/subjects')
  @ApiOperation({
    summary: 'Assign subjects to teacher',
    description:
      'Assigns or updates the subjects a teacher can teach. Replaces all existing subject assignments. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Teacher profile ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Subjects assigned successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Teacher not found',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'One or more subjects not found',
  })
  async assignSubjects(
    @Param('id', ParseIntPipe) id: number,
    @Body() assignDto: AssignSubjectsDto,
  ) {
    const teacher = await this.teachersService.assignSubjects(id, assignDto);
    return {
      message: 'Subjects assigned successfully',
      teacher,
    };
  }
}
