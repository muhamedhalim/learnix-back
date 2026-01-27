import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
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
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import {
  CreateExamDto,
  ExamFilterDto,
  GradeEssayDto,
  UpdateExamDto,
} from '../dto';
import { ExamsService } from '../exams.service';

@ApiTags('Teacher Exams')
@Controller('teacher/exams')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherExamsController {
  constructor(private readonly examsService: ExamsService) {}

  /**
   * Create a new exam
   */
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Subject not found',
  })
  public async create(
    @GetUser() user: JwtPayload,
    @Body() createDto: CreateExamDto,
  ): Promise<{ message: string; exam: unknown }> {
    const exam = await this.examsService.create(user.userId, createDto);
    return {
      message: 'Exam created successfully',
      exam,
    };
  }

  /**
   * Get my exams
   */
  @Get()
  @ApiOperation({
    summary: 'Get my exams',
    description:
      "Returns a paginated list of the authenticated teacher's exams with submission stats.",
  })
  @ApiQuery({ name: 'search', required: false, description: 'Search by title' })
  @ApiQuery({
    name: 'subject_id',
    required: false,
    type: Number,
    description: 'Filter by subject ID',
  })
  @ApiQuery({
    name: 'is_active',
    required: false,
    type: Boolean,
    description: 'Filter by active status',
  })
  @ApiQuery({
    name: 'sort_by',
    required: false,
    enum: ['created_at', 'title', 'total_marks', 'duration'],
    description: 'Sort field',
  })
  @ApiQuery({
    name: 'sort_order',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order',
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
    description: "List of teacher's exams with stats",
  })
  public async findMyExams(
    @GetUser() user: JwtPayload,
    @Query() filter: ExamFilterDto,
  ): Promise<{
    data: unknown[];
    meta: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      hasNextPage: boolean;
      hasPrevPage: boolean;
    };
  }> {
    return await this.examsService.findMyExams(user.userId, filter);
  }

  /**
   * Get exam submissions for grading
   */
  @Get(':id/submissions')
  @ApiOperation({
    summary: 'Get exam submissions',
    description:
      'Returns all student submissions for an exam, including essay answers for grading.',
  })
  @ApiParam({ name: 'id', description: 'Exam ID' })
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
    status: HttpStatus.FORBIDDEN,
    description: 'You can only view submissions for your own exams',
  })
  public async getSubmissions(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ): Promise<unknown> {
    return await this.examsService.getSubmissions(
      examId,
      user.userId,
      page ?? 1,
      limit ?? 20,
    );
  }

  /**
   * Grade an essay question
   */
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only grade your own exams',
  })
  public async gradeEssay(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
    @Body() gradeDto: GradeEssayDto,
  ): Promise<unknown> {
    return await this.examsService.gradeEssay(user.userId, examId, gradeDto);
  }

  /**
   * Update an exam
   */
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only update your own exams',
  })
  public async update(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
    @Body() updateDto: UpdateExamDto,
  ): Promise<{ message: string; exam: unknown }> {
    const exam = await this.examsService.update(examId, user.userId, updateDto);
    return {
      message: 'Exam updated successfully',
      exam,
    };
  }

  /**
   * Delete an exam
   */
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only delete your own exams',
  })
  public async delete(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
  ): Promise<{ message: string }> {
    await this.examsService.delete(examId, user.userId);
    return {
      message: 'Exam deleted successfully',
    };
  }
}
