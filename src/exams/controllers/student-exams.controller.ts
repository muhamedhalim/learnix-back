import {
  Controller,
  Get,
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
import { StudentExamFilterDto } from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';

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
  async findAvailableExams(
    @GetUser() user: JwtPayload,
    @Query() filter: StudentExamFilterDto,
  ) {
    return this.examsService.findAvailableExams(user.userId, filter);
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
  async getExamResult(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
  ) {
    return this.examsService.getExamResult(user.userId, examId);
  }
}
