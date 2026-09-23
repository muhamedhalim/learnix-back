import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { InvalidatesCache } from '../../../common/cache/cache-invalidation.decorator';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { ReportReviewDto } from '../dto/report-review.dto';
import { ReviewModerationService } from '../review-moderation.service';

/**
 * Contracts §4: `POST /marketplace/reviews/:id/report` (FR-260). A
 * separate controller/path from `marketplace/me/reviews` because reporting
 * targets ANY review, not just the caller's own — any authenticated user,
 * no ownership scoping.
 */
@ApiTags('Marketplace / Reviews')
@Controller('marketplace/reviews')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class ReviewReportController {
  constructor(private readonly moderation: ReviewModerationService) {}

  @Post(':id/report')
  // Writes `marketplace_review_reports` and increments `marketplace_course_reviews.report_count`. The
  // catalogue does not read `report_count`; declared at table level (a skip candidate) (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'Report a review; does not itself hide it (FR-260)' })
  public async report(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportReviewDto,
  ): Promise<void> {
    return this.moderation.report(user.userId, id, dto.reason);
  }
}
