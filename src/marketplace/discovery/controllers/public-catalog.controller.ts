import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OptionalJwtAuthGuard } from '../../../auth/guards/optional-jwt-auth.guard';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { MarketplaceEnrollmentStatus } from '../../common/enums';
import { MarketplaceEnrollment } from '../../commerce/entities';
import type { CatalogListResult } from '../catalog-query.service';
import { CatalogQueryService } from '../catalog-query.service';
import type { PublicCourseCurriculum, PublicCourseDetail } from '../course-detail.service';
import { CourseDetailService } from '../course-detail.service';
import { CatalogQueryDto } from '../dto/catalog-query.dto';
import type { PreviewLessonContent } from '../preview-access.service';
import { PreviewAccessService } from '../preview-access.service';

export interface PublicCourseDetailResponse extends PublicCourseDetail {
  /** FR-090 — set only for an authenticated learner who already holds an active enrollment. */
  viewer_enrollment: { enrolled: boolean; enrollment_id: string | null };
}

/** Contracts §1 — no auth required on any route here (FR-076, FR-087). */
@ApiTags('Marketplace / Public')
@Controller('marketplace/courses')
export class PublicCatalogController {
  constructor(
    private readonly catalogQuery: CatalogQueryService,
    private readonly courseDetail: CourseDetailService,
    private readonly previewAccess: PreviewAccessService,
    @InjectRepository(MarketplaceEnrollment)
    private readonly enrollments: Repository<MarketplaceEnrollment>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Listing with search, filters, sort, pagination (FR-076 – FR-082)' })
  public async list(@Query() query: CatalogQueryDto): Promise<CatalogListResult> {
    return this.catalogQuery.list(query);
  }

  @Get(':slug')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Public course detail (FR-083); 404, never 403, when not visible (FR-087)' })
  public async detail(@Param('slug') slug: string, @GetUser() user: JwtPayload | undefined): Promise<PublicCourseDetailResponse> {
    const detail = await this.courseDetail.getBySlug(slug);
    const activeEnrollment = user
      ? await this.enrollments.findOne({
          where: { learner_id: user.userId, course_id: detail.id, status: MarketplaceEnrollmentStatus.ACTIVE },
        })
      : null;

    return {
      ...detail,
      viewer_enrollment: { enrolled: !!activeEnrollment, enrollment_id: activeEnrollment?.id ?? null },
    };
  }

  @Get(':slug/curriculum')
  @ApiOperation({ summary: 'Sections and lessons, titles + durations only (FR-083, FR-084)' })
  public async curriculum(@Param('slug') slug: string): Promise<PublicCourseCurriculum> {
    return this.courseDetail.getCurriculumBySlug(slug);
  }

  @Get(':slug/preview/:lessonId')
  @ApiOperation({ summary: 'Signed playback for a free-preview lesson only (FR-048, FR-084)' })
  public async preview(@Param('slug') slug: string, @Param('lessonId') lessonId: string): Promise<PreviewLessonContent> {
    return this.previewAccess.getPreviewLesson(slug, lessonId);
  }
}
