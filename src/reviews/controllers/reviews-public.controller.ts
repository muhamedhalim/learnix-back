import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse,ApiTags } from '@nestjs/swagger';

import { ReviewFilterDto } from '../dto';
import { ReviewsService } from '../reviews.service';

@ApiTags('Reviews')
@Controller()
export class ReviewsPublicController {
  constructor(private reviewsService: ReviewsService) {}

  @Get('teachers/:teacherId/reviews')
  @ApiOperation({ summary: 'Get teacher reviews with aggregates (public)' })
  @ApiResponse({ status: 404, description: 'Teacher not found' })
  public async getTeacherReviews(
    @Param('teacherId') teacherId: string,
    @Query() filter: ReviewFilterDto,
  ): Promise<unknown> {
    return this.reviewsService.getTeacherReviews(
      teacherId,
      filter.page,
      filter.limit,
    );
  }

  @Get('lessons/:lessonId/reviews')
  @ApiOperation({ summary: 'Get lesson reviews with aggregates (public)' })
  @ApiResponse({ status: 404, description: 'Lesson not found' })
  public async getLessonReviews(
    @Param('lessonId') lessonId: string,
    @Query() filter: ReviewFilterDto,
  ): Promise<unknown> {
    return this.reviewsService.getLessonReviews(
      lessonId,
      filter.page,
      filter.limit,
    );
  }
}
