import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseIntPipe,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { ExamsService } from '../exams.service';
import { SubmitExamDto } from '../dto';
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
    @Param('id', ParseIntPipe) examId: number,
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
