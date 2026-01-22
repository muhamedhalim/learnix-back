import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ReviewsService } from '../reviews.service';
import { ReviewFilterDto } from '../dto';

@ApiTags('Reviews')
@Controller()
export class ReviewsPublicController {
  constructor(private reviewsService: ReviewsService) {}

  @Get('teachers/:teacherId/reviews')
  @ApiOperation({ summary: 'Get teacher reviews with aggregates (public)' })
  @ApiResponse({
    status: 200,
    description: 'Teacher reviews retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Teacher not found' })
  async getTeacherReviews(
    @Param('teacherId') teacherId: string,
    @Query() filter: ReviewFilterDto,
  ) {
    return this.reviewsService.getTeacherReviews(
      teacherId,
      filter.page,
      filter.limit,
    );
  }

  @Get('lessons/:lessonId/reviews')
  @ApiOperation({ summary: 'Get lesson reviews with aggregates (public)' })
  @ApiResponse({
    status: 200,
    description: 'Lesson reviews retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Lesson not found' })
  async getLessonReviews(
    @Param('lessonId') lessonId: string,
    @Query() filter: ReviewFilterDto,
  ) {
    return this.reviewsService.getLessonReviews(
      lessonId,
      filter.page,
      filter.limit,
    );
  }
}
