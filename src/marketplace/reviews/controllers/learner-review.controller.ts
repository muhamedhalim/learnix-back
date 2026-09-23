import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { InvalidatesCache } from '../../../common/cache/cache-invalidation.decorator';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { CreateReviewDto } from '../dto/create-review.dto';
import { UpdateReviewDto } from '../dto/update-review.dto';
import { MarketplaceCourseReview } from '../entities';
import { MarketplaceReviewService } from '../review.service';

/** Contracts §4: `GET/POST/PATCH/DELETE /marketplace/me/reviews[/:id]` (FR-253 – FR-255). */
@ApiTags('Marketplace / My Reviews')
@Controller('marketplace/me/reviews')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class LearnerReviewController {
  constructor(private readonly reviews: MarketplaceReviewService) {}

  @Get()
  @ApiOperation({ summary: 'All of the caller’s own reviews across every course' })
  public async list(@GetUser() user: JwtPayload): Promise<MarketplaceCourseReview[]> {
    return this.reviews.listOwnReviews(user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of the caller’s own reviews' })
  public async get(@GetUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<MarketplaceCourseReview> {
    return this.reviews.getOwnReview(user.userId, id);
  }

  @Post()
  // Writes `marketplace_course_reviews` (rating/comment feed the catalogue aggregates) plus a notification
  // row for the instructor via listener; no family reads notifications (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'Review an enrolled course; one per learner per course (FR-253, FR-255)' })
  public async create(@GetUser() user: JwtPayload, @Body() dto: CreateReviewDto): Promise<MarketplaceCourseReview> {
    return this.reviews.createReview(user.userId, dto);
  }

  @Patch(':id')
  // Writes `marketplace_course_reviews` only (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'Edit the caller’s own review (FR-255)' })
  public async update(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReviewDto,
  ): Promise<MarketplaceCourseReview> {
    return this.reviews.updateOwnReview(user.userId, id, dto);
  }

  @Delete(':id')
  // Deletes a `marketplace_course_reviews` row only (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'Delete the caller’s own review (FR-255)' })
  public async remove(@GetUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.reviews.deleteOwnReview(user.userId, id);
  }
}
