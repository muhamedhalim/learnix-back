import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ModerateReviewDto, ModerationFilterDto } from '../dto';
import { ReviewTargetType } from '../entities/review-helpful-vote.entity';
import { ReviewsService } from '../reviews.service';

@ApiTags('Admin · Reviews')
@Controller('admin/reviews')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Get('lessons')
  @ApiOperation({ summary: 'List lesson reviews for moderation' })
  public async lessonReviews(
    @Query() filter: ModerationFilterDto,
  ): Promise<unknown> {
    return this.reviewsService.getLessonReviewsForModeration(
      filter.page,
      filter.limit,
      filter.status,
    );
  }

  @Get('teachers')
  @ApiOperation({ summary: 'List teacher reviews for moderation' })
  public async teacherReviews(
    @Query() filter: ModerationFilterDto,
  ): Promise<unknown> {
    return this.reviewsService.getTeacherReviewsForModeration(
      filter.page,
      filter.limit,
      filter.status,
    );
  }

  @Patch(':type/:reviewId/status')
  @ApiOperation({ summary: 'Set a review moderation status' })
  @ApiParam({ name: 'type', enum: ReviewTargetType })
  public async moderate(
    @Param('type', new ParseEnumPipe(ReviewTargetType)) type: ReviewTargetType,
    @Param('reviewId') reviewId: string,
    @Body() dto: ModerateReviewDto,
  ): Promise<unknown> {
    return this.reviewsService.moderateReview(type, reviewId, dto.status);
  }

  @Delete(':type/:reviewId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a review (moderation)' })
  @ApiParam({ name: 'type', enum: ReviewTargetType })
  public async remove(
    @Param('type', new ParseEnumPipe(ReviewTargetType)) type: ReviewTargetType,
    @Param('reviewId') reviewId: string,
  ): Promise<{ message: string }> {
    await this.reviewsService.adminDeleteReview(type, reviewId);
    return { message: 'Review deleted' };
  }
}
