import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { InvalidatesCache } from '../../../common/cache/cache-invalidation.decorator';
import { ApprovedInstructor } from '../../common/decorators/approved-instructor.decorator';
import { CurrentInstructor } from '../../common/decorators/current-instructor.decorator';
import { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';
import { ReplyReviewDto } from '../dto/reply-review.dto';
import { MarketplaceCourseReview } from '../entities';
import { CourseRatingAggregate, ReviewAggregateService } from '../review-aggregate.service';
import { ReviewReplyService } from '../review-reply.service';
import { MarketplaceReviewService } from '../review.service';

export interface InstructorReviewList {
  data: MarketplaceCourseReview[];
  aggregatesByCourse: Record<string, CourseRatingAggregate>;
}

/** Contracts §4: `GET /marketplace/instructor/reviews`, `POST/PATCH/DELETE /marketplace/instructor/reviews/:id/reply` (FR-259, FR-266). */
@ApiTags('Marketplace / Instructor Reviews')
@Controller('marketplace/instructor/reviews')
@ApprovedInstructor()
@ApiBearerAuth('JWT-auth')
export class InstructorReviewController {
  constructor(
    private readonly reviews: MarketplaceReviewService,
    private readonly aggregates: ReviewAggregateService,
    private readonly reply: ReviewReplyService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Every review across the caller’s own courses, with the aggregate rating per course (FR-266)' })
  public async list(@CurrentInstructor() instructor: MarketplaceInstructor): Promise<InstructorReviewList> {
    const data = await this.reviews.listForInstructor(instructor.id);
    const courseIds = [...new Set(data.map((review) => review.course_id))];
    const aggregateMap = await this.aggregates.getCourseAggregatesBatch(courseIds);
    const aggregatesByCourse: Record<string, CourseRatingAggregate> = {};
    for (const courseId of courseIds) {
      aggregatesByCourse[courseId] = aggregateMap.get(courseId) ?? {
        averageRating: 0,
        reviewCount: 0,
        ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      };
    }
    return { data, aggregatesByCourse };
  }

  @Post(':id/reply')
  // Writes `marketplace_course_reviews.instructor_reply*` only. No family reads the reply columns today;
  // declared at table level because `marketplace_catalog` reads this table (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'Reply to a review on the caller’s own course (FR-259)' })
  public async createReply(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplyReviewDto,
  ): Promise<MarketplaceCourseReview> {
    return this.reply.reply(instructor.id, id, dto.reply);
  }

  @Put(':id/reply')
  // Same write set as POST reply (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'Edit the reply — overwrites the existing one (FR-259)' })
  public async updateReply(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplyReviewDto,
  ): Promise<MarketplaceCourseReview> {
    return this.reply.reply(instructor.id, id, dto.reply);
  }

  @Delete(':id/reply')
  // Same write set as POST reply (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'Remove the reply (FR-259)' })
  public async deleteReply(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MarketplaceCourseReview> {
    return this.reply.deleteReply(instructor.id, id);
  }
}
