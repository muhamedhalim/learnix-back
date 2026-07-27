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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Throttle } from '@nestjs/throttler';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { THROTTLE } from '../../common/constants';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { CreateReviewDto, UpdateReviewDto } from '../dto';
import { ReviewTargetType } from '../entities/review-helpful-vote.entity';
import { ReviewsService } from '../reviews.service';

@ApiTags('Reviews')
@Controller('student')
@UseGuards(HybridAuthGuard, RolesGuard)
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
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return this.reviewsService.createTeacherReview(teacherId, user.userId, dto);
  }

  @Patch('teachers/:teacherId/reviews')
  @ApiOperation({ summary: 'Edit your teacher review' })
  public async updateTeacherReview(
    @Param('teacherId') teacherId: string,
    @Body() dto: UpdateReviewDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return this.reviewsService.updateTeacherReview(teacherId, user.userId, dto);
  }

  @Delete('teachers/:teacherId/reviews')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete your teacher review' })
  public async deleteTeacherReview(
    @Param('teacherId') teacherId: string,
    @GetUser() user: JwtPayload,
  ): Promise<{ message: string }> {
    await this.reviewsService.deleteTeacherReview(teacherId, user.userId);
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
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return this.reviewsService.createLessonReview(lessonId, user.userId, dto);
  }

  @Patch('lessons/:lessonId/reviews')
  @ApiOperation({ summary: 'Edit your lesson review' })
  public async updateLessonReview(
    @Param('lessonId') lessonId: string,
    @Body() dto: UpdateReviewDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return this.reviewsService.updateLessonReview(lessonId, user.userId, dto);
  }

  @Delete('lessons/:lessonId/reviews')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete your lesson review' })
  public async deleteLessonReview(
    @Param('lessonId') lessonId: string,
    @GetUser() user: JwtPayload,
  ): Promise<{ message: string }> {
    await this.reviewsService.deleteLessonReview(lessonId, user.userId);
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
    @GetUser() user: JwtPayload,
  ): Promise<{ helpful: boolean; helpful_count: number }> {
    return this.reviewsService.toggleHelpfulVote(type, reviewId, user.userId);
  }
}
