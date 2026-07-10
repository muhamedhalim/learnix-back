import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { THROTTLE } from '../../common/constants';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateReviewDto, UpdateReviewDto } from '../dto';
import { ReviewTargetType } from '../entities/review-helpful-vote.entity';
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
@ApiBearerAuth('JWT-auth')
export class ReviewsStudentController {
  constructor(private readonly reviewsService: ReviewsService) {}

  /* ----- Teacher reviews ----- */

  @Post('teachers/:teacherId/reviews')
  @Throttle({ default: THROTTLE.DEFAULT })
  @ApiOperation({ summary: 'Create a teacher review (student)' })
  @ApiResponse({ status: 404, description: 'Teacher not found' })
  public async createTeacherReview(
    @Param('teacherId') teacherId: string,
    @Body() dto: CreateReviewDto,
    @Request() req: AuthRequest,
  ): Promise<unknown> {
    return this.reviewsService.createTeacherReview(teacherId, req.user.id, dto);
  }

  @Patch('teachers/:teacherId/reviews')
  @ApiOperation({ summary: 'Edit your teacher review' })
  public async updateTeacherReview(
    @Param('teacherId') teacherId: string,
    @Body() dto: UpdateReviewDto,
    @Request() req: AuthRequest,
  ): Promise<unknown> {
    return this.reviewsService.updateTeacherReview(teacherId, req.user.id, dto);
  }

  @Delete('teachers/:teacherId/reviews')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete your teacher review' })
  public async deleteTeacherReview(
    @Param('teacherId') teacherId: string,
    @Request() req: AuthRequest,
  ): Promise<{ message: string }> {
    await this.reviewsService.deleteTeacherReview(teacherId, req.user.id);
    return { message: 'Review deleted' };
  }

  /* ----- Lesson reviews ----- */

  @Post('lessons/:lessonId/reviews')
  @Throttle({ default: THROTTLE.DEFAULT })
  @ApiOperation({ summary: 'Create a lesson review (student)' })
  @ApiResponse({ status: 404, description: 'Lesson not found' })
  public async createLessonReview(
    @Param('lessonId') lessonId: string,
    @Body() dto: CreateReviewDto,
    @Request() req: AuthRequest,
  ): Promise<unknown> {
    return this.reviewsService.createLessonReview(lessonId, req.user.id, dto);
  }

  @Patch('lessons/:lessonId/reviews')
  @ApiOperation({ summary: 'Edit your lesson review' })
  public async updateLessonReview(
    @Param('lessonId') lessonId: string,
    @Body() dto: UpdateReviewDto,
    @Request() req: AuthRequest,
  ): Promise<unknown> {
    return this.reviewsService.updateLessonReview(lessonId, req.user.id, dto);
  }

  @Delete('lessons/:lessonId/reviews')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete your lesson review' })
  public async deleteLessonReview(
    @Param('lessonId') lessonId: string,
    @Request() req: AuthRequest,
  ): Promise<{ message: string }> {
    await this.reviewsService.deleteLessonReview(lessonId, req.user.id);
    return { message: 'Review deleted' };
  }

  /* ----- Helpful votes ----- */

  @Post('reviews/:type/:reviewId/helpful')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle a "helpful" vote on a review' })
  @ApiParam({ name: 'type', enum: ReviewTargetType })
  public async toggleHelpful(
    @Param('type', new ParseEnumPipe(ReviewTargetType)) type: ReviewTargetType,
    @Param('reviewId') reviewId: string,
    @Request() req: AuthRequest,
  ): Promise<{ helpful: boolean; helpful_count: number }> {
    return this.reviewsService.toggleHelpfulVote(type, reviewId, req.user.id);
  }
}
