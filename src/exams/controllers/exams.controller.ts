import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { GetUser } from '../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { ExamFilterDto,SubmitExamDto } from '../dto';
import { ExamsService } from '../exams.service';

@ApiTags('Exams')
@Controller('exams')
export class ExamsController {
  constructor(private readonly examsService: ExamsService) {}

  /**
   * Get all available exams with search and filters (public)
   */
  @Get()
  @ApiOperation({
    summary: 'Get all exams (public)',
    description:
      'Returns a paginated list of active exams. Supports search by title, filter by subject, and sorting.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by exam title (English or Arabic)',
  })
  @ApiQuery({
    name: 'subject_id',
    required: false,
    description: 'Filter by subject ID',
  })
  @ApiQuery({
    name: 'is_active',
    required: false,
    type: Boolean,
    description: 'Filter by active status (default: true)',
  })
  @ApiQuery({
    name: 'sort_by',
    required: false,
    enum: ['created_at', 'title', 'total_marks'],
    description: 'Sort by field (default: created_at)',
  })
  @ApiQuery({
    name: 'sort_order',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order (default: DESC)',
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
    description: 'List of exams with pagination meta',
  })
  public async findAll(@Query() filter: ExamFilterDto): Promise<{ data: unknown[]; meta: { page: number; limit: number; total: number; totalPages: number; hasNextPage: boolean; hasPrevPage: boolean } }> {
    return this.examsService.findAll(filter);
  }

  /**
   * Get exam preview (public)
   * Returns metadata only - no questions or answers
   */
  @Get(':id/preview')
  @ApiOperation({
    summary: 'Get exam preview (public)',
    description:
      'Returns exam metadata including title, duration, question counts, and passing marks. Does NOT include questions or answers.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Exam not found or inactive',
  })
  public async getExamPreview(@Param('id', ParseUUIDPipe) examId: string): Promise<unknown> {
    return this.examsService.getExamPreview(examId);
  }

  /**
   * Get exam for taking (student only)
   * Returns exam without correct answers
   */
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'You have already submitted this exam',
  })
  public async getExamForTaking(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
  ): Promise<unknown> {
    return this.examsService.findOneForTaking(examId, user.userId);
  }

  /**
   * Submit exam answers (student only)
   * Auto-grades MCQ questions immediately
   */
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'You have already submitted this exam',
  })
  public async submitExam(
    @GetUser() user: JwtPayload,
    @Body() submitDto: SubmitExamDto,
  ): Promise<unknown> {
    return this.examsService.submitExam(user.userId, submitDto);
  }
}
