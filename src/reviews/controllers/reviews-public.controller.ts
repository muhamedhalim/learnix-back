import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ReviewFilterDto } from '../dto';
import { ReviewsService } from '../reviews.service';

@ApiTags('Reviews')
@Controller()
export class ReviewsPublicController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Get('teachers/:teacherId/reviews')
  @ApiOperation({ summary: 'Get teacher reviews with aggregates (public)' })
  @ApiResponse({ status: 404, description: 'Teacher not found' })
  public async getTeacherReviews(
    @Param('teacherId') teacherId: string,
    @Query() filter: ReviewFilterDto,
  ): Promise<unknown> {
    return await this.reviewsService.getTeacherReviews(
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
    return await this.reviewsService.getLessonReviews(
      lessonId,
      filter.page,
      filter.limit,
    );
  }

  @Get('packages/:packageId/reviews/summary')
  @ApiOperation({
    summary: 'Course (package) rating summary, derived from its lessons',
  })
  @ApiResponse({ status: 404, description: 'Package not found' })
  public async getPackageReviewSummary(
    @Param('packageId') packageId: string,
  ): Promise<unknown> {
    return await this.reviewsService.getPackageAggregates(packageId);
  }
}
