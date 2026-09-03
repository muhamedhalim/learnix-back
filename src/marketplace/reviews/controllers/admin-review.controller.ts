import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { CourseReviewStatus } from '../../common/enums';
import { ModerateReviewDto } from '../dto/moderate-review.dto';
import { MarketplaceCourseReview } from '../entities';
import { ReviewModerationQueue, ReviewModerationService } from '../review-moderation.service';

/**
 * Contracts §4: `GET /marketplace/admin/reviews`, `POST /marketplace/admin/reviews/:id/moderate`
 * (FR-261). Plain `RolesGuard` — review moderation is not a financial
 * action, so unlike refunds/payouts there is no `marketplace.reviews.*`
 * finance-permission string, matching `AdminCoursesController`'s/
 * `AdminCategoriesController`'s identical guard stack.
 */
@ApiTags('Marketplace / Admin / Reviews')
@Controller('marketplace/admin/reviews')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminReviewController {
  constructor(private readonly moderation: ReviewModerationService) {}

  @Get()
  @ApiOperation({ summary: 'Reported and flagged reviews, or a specific status (FR-261)' })
  public async queue(
    @Query('status') status?: CourseReviewStatus,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ): Promise<ReviewModerationQueue> {
    return this.moderation.listForModeration(status, Number(page), Number(limit));
  }

  @Post(':id/moderate')
  @ApiOperation({ summary: 'Approve, hide or remove a review; reason mandatory except to approve (FR-261, FR-262)' })
  public async moderate(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerateReviewDto,
  ): Promise<MarketplaceCourseReview> {
    return this.moderation.moderate(user.userId, id, dto);
  }
}
