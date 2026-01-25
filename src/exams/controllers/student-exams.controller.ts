import {
  Controller,
  Get,
  HttpStatus,
  Param,
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
import { StudentExamFilterDto } from '../dto';
import { ExamsService } from '../exams.service';

@ApiTags('Student Exams')
@Controller('student/exams')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class StudentExamsController {
  constructor(private readonly examsService: ExamsService) {}

  /**
   * Get available exams
   */
  @Get()
  @ApiOperation({
    summary: 'Get available exams',
    description:
      'Returns a paginated list of active exams. Can filter by attempted/not attempted.',
  })
  @ApiQuery({ name: 'search', required: false, description: 'Search by title' })
  @ApiQuery({
    name: 'subject_id',
    required: false,
    type: Number,
    description: 'Filter by subject ID',
  })
  @ApiQuery({
    name: 'attempted',
    required: false,
    type: Boolean,
    description: 'Filter by attempted status (true/false)',
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
    description: 'List of available exams',
  })
  public async findAvailableExams(
    @GetUser() user: JwtPayload,
    @Query() filter: StudentExamFilterDto,
  ): Promise<{ data: unknown[]; meta: { page: number; limit: number; total: number; totalPages: number; hasNextPage: boolean; hasPrevPage: boolean } }> {
    return this.examsService.findAvailableExams(user.userId, filter);
  }

  /**
   * Start an exam attempt
   * Creates IN_PROGRESS attempt and returns questions WITHOUT correct answers
   */
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Exam already submitted',
  })
  public async startExam(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
  ): Promise<unknown> {
    return this.examsService.startExam(user.userId, examId);
  }

  /**
   * Get exam result
   */
  @Get(':id/result')
  @ApiOperation({
    summary: 'Get exam result',
    description:
      'Returns the graded result for an exam. Only available when all questions are graded (status = GRADED).',
  })
  @ApiParam({ name: 'id', description: 'Exam ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Exam result with scores and feedback',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Results not available yet (still being graded)',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Exam not found or not submitted',
  })
  public async getExamResult(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
  ): Promise<unknown> {
    return this.examsService.getExamResult(user.userId, examId);
  }
}
