import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
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
import { ReplyReviewDto, ReviewFilterDto } from '../dto';
import { ReviewsService } from '../reviews.service';

interface AuthRequest extends Request {
  user: { id: string; email: string; role: string };
}

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
    @Request() req: AuthRequest,
  ): Promise<unknown> {
    return this.reviewsService.getTeacherLessonReviews(
      req.user.id,
      filter.page,
      filter.limit,
    );
  }

  @Post(':reviewId/reply')
  @ApiOperation({ summary: "Reply to a review on one of the teacher's lessons" })
  @ApiResponse({ status: 403, description: 'Not your lesson' })
  public async reply(
    @Param('reviewId') reviewId: string,
    @Body() dto: ReplyReviewDto,
    @Request() req: AuthRequest,
  ): Promise<unknown> {
    return this.reviewsService.replyToLessonReview(reviewId, req.user.id, dto.reply);
  }

  @Post('profile/:reviewId/reply')
  @ApiOperation({ summary: 'Reply to a review on the authenticated teacher profile' })
  @ApiResponse({ status: 403, description: 'Not your profile review' })
  public async replyToProfileReview(
    @Param('reviewId') reviewId: string,
    @Body() dto: ReplyReviewDto,
    @Request() req: AuthRequest,
  ): Promise<unknown> {
    return this.reviewsService.replyToTeacherReview(reviewId, req.user.id, dto.reply);
  }
}
