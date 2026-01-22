import {
  Controller,
  Post,
  Param,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ReviewsService } from '../reviews.service';
import { CreateReviewDto } from '../dto';

interface AuthRequest extends Request {
  user: {
    id: string;
    email: string;
    role: string;
  };
}

@ApiTags('Reviews')
@Controller('student')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT')
export class ReviewsStudentController {
  constructor(private reviewsService: ReviewsService) {}

  @Post('teachers/:teacherId/reviews')
  @ApiOperation({ summary: 'Create a teacher review (student)' })
  @ApiResponse({ status: 201, description: 'Review created successfully' })
  @ApiResponse({
    status: 403,
    description: 'Student must purchase from teacher before reviewing',
  })
  @ApiResponse({
    status: 409,
    description: 'Student has already reviewed this teacher',
  })
  @ApiResponse({ status: 404, description: 'Teacher not found' })
  async createTeacherReview(
    @Param('teacherId') teacherId: string,
    @Body() dto: CreateReviewDto,
    @Request() req: AuthRequest,
  ) {
    return this.reviewsService.createTeacherReview(teacherId, req.user.id, dto);
  }

  @Post('lessons/:lessonId/reviews')
  @ApiOperation({ summary: 'Create a lesson review (student)' })
  @ApiResponse({ status: 201, description: 'Review created successfully' })
  @ApiResponse({
    status: 403,
    description: 'Student must purchase lesson before reviewing',
  })
  @ApiResponse({
    status: 409,
    description: 'Student has already reviewed this lesson',
  })
  @ApiResponse({ status: 404, description: 'Lesson not found' })
  async createLessonReview(
    @Param('lessonId') lessonId: string,
    @Body() dto: CreateReviewDto,
    @Request() req: AuthRequest,
  ) {
    return this.reviewsService.createLessonReview(lessonId, req.user.id, dto);
  }
}
