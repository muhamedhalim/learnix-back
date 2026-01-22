import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpStatus,
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
import { ExamsService } from '../exams.service';
import { SubmitExamDto, ExamFilterDto } from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';

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
  async findAll(@Query() filter: ExamFilterDto) {
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
  @ApiParam({ name: 'id', description: 'Exam ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Exam preview with metadata only',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Exam not found or inactive',
  })
  async getExamPreview(@Param('id', ParseUUIDPipe) examId: string) {
    return this.examsService.getExamPreview(examId);
  }

  /**
   * Get exam for taking (student only)
   * Returns exam without correct answers
   */
  @Get(':id')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('student')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Get exam for taking',
    description:
      'Returns exam details with questions but WITHOUT correct answers. Student must not have already submitted.',
  })
  @ApiParam({ name: 'id', description: 'Exam ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Exam details for taking',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Exam not found or inactive',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'You have already submitted this exam',
  })
  async getExamForTaking(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
  ) {
    return this.examsService.findOneForTaking(examId, user.userId);
  }

  /**
   * Submit exam answers (student only)
   * Auto-grades MCQ questions immediately
   */
  @Post('submit')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('student')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Submit exam answers',
    description:
      'Submits exam answers. MCQ questions are auto-graded immediately. Essay questions await teacher grading.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Exam submitted successfully with MCQ score',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid answers or missing questions',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Exam not found or inactive',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'You have already submitted this exam',
  })
  async submitExam(
    @GetUser() user: JwtPayload,
    @Body() submitDto: SubmitExamDto,
  ) {
    return this.examsService.submitExam(user.userId, submitDto);
  }
}
