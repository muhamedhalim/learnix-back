import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { ReplyReviewDto, ReviewFilterDto } from '../dto';
import { ReviewsService } from '../reviews.service';

@ApiTags('Reviews · Teacher')
@Controller('teacher/reviews')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class ReviewsTeacherController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Get()
  @ApiOperation({ summary: "Reviews across all of the teacher's lessons" })
  public async myLessonReviews(
    @Query() filter: ReviewFilterDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return this.reviewsService.getTeacherLessonReviews(user.userId, filter.page, filter.limit);
  }

  @Post(':reviewId/reply')
  @ApiOperation({ summary: "Reply to a review on one of the teacher's lessons" })
  @ApiResponse({ status: 403, description: 'Not your lesson' })
  public async reply(
    @Param('reviewId') reviewId: string,
    @Body() dto: ReplyReviewDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return this.reviewsService.replyToLessonReview(reviewId, user.userId, dto.reply);
  }

  @Post('profile/:reviewId/reply')
  @ApiOperation({ summary: 'Reply to a review on the authenticated teacher profile' })
  @ApiResponse({ status: 403, description: 'Not your profile review' })
  public async replyToProfileReview(
    @Param('reviewId') reviewId: string,
    @Body() dto: ReplyReviewDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return this.reviewsService.replyToTeacherReview(reviewId, user.userId, dto.reply);
  }
}
