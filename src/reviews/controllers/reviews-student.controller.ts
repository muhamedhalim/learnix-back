import {
  Body,
  Controller,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateReviewDto } from '../dto';
import { ReviewsService } from '../reviews.service';

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
  @ApiResponse({ status: 404, description: 'Teacher not found' })
  public async createTeacherReview(
    @Param('teacherId') teacherId: string,
    @Body() dto: CreateReviewDto,
    @Request() req: AuthRequest,
  ): Promise<unknown> {
    return this.reviewsService.createTeacherReview(teacherId, req.user.id, dto);
  }

  @Post('lessons/:lessonId/reviews')
  @ApiOperation({ summary: 'Create a lesson review (student)' })
  @ApiResponse({ status: 404, description: 'Lesson not found' })
  public async createLessonReview(
    @Param('lessonId') lessonId: string,
    @Body() dto: CreateReviewDto,
    @Request() req: AuthRequest,
  ): Promise<unknown> {
    return this.reviewsService.createLessonReview(lessonId, req.user.id, dto);
  }
}
