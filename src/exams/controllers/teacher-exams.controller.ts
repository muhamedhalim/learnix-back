import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  ParseIntPipe,
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
import {
  CreateExamDto,
  UpdateExamDto,
  GradeEssayDto,
  ExamFilterDto,
} from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';

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
  @Post()
  @ApiOperation({
    summary: 'Create an exam',
    description:
      'Creates a new exam with MCQ and/or essay questions. Total marks are auto-calculated from question marks.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Exam created successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid input data or validation error',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Subject not found',
  })
  async create(@GetUser() user: JwtPayload, @Body() createDto: CreateExamDto) {
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
  async findMyExams(
    @GetUser() user: JwtPayload,
    @Query() filter: ExamFilterDto,
  ) {
    return this.examsService.findMyExams(user.userId, filter);
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
    status: HttpStatus.OK,
    description: 'List of student submissions',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Exam not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only view submissions for your own exams',
  })
  async getSubmissions(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.examsService.getSubmissions(
      examId,
      user.userId,
      page || 1,
      limit || 20,
    );
  }

  /**
   * Grade an essay question
   */
  @Post(':id/grade-essay')
  @ApiOperation({
    summary: 'Grade an essay question',
    description:
      'Grades a single essay question for a student. When all essays are graded, status changes to GRADED.',
  })
  @ApiParam({ name: 'id', description: 'Exam ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Essay graded successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'Invalid question index, not an essay, or score exceeds max marks',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Exam or submission not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only grade your own exams',
  })
  async gradeEssay(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
    @Body() gradeDto: GradeEssayDto,
  ) {
    return this.examsService.gradeEssay(user.userId, examId, gradeDto);
  }

  /**
   * Update an exam
   */
  @Put(':id')
  @ApiOperation({
    summary: 'Update an exam',
    description:
      'Updates an exam. Not allowed if the exam has any submissions.',
  })
  @ApiParam({ name: 'id', description: 'Exam ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Exam updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Cannot update exam with existing submissions',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Exam not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only update your own exams',
  })
  async update(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
    @Body() updateDto: UpdateExamDto,
  ) {
    const exam = await this.examsService.update(examId, user.userId, updateDto);
    return {
      message: 'Exam updated successfully',
      exam,
    };
  }

  /**
   * Delete an exam
   */
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete an exam',
    description: 'Soft deletes an exam owned by the authenticated teacher.',
  })
  @ApiParam({ name: 'id', description: 'Exam ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Exam deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Exam not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only delete your own exams',
  })
  async delete(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
  ) {
    await this.examsService.delete(examId, user.userId);
    return {
      message: 'Exam deleted successfully',
    };
  }
}
