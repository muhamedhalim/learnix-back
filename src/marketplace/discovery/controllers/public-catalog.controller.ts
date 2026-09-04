import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OptionalJwtAuthGuard } from '../../../auth/guards/optional-jwt-auth.guard';
import { ApplicationCacheService } from '../../../common/cache/application-cache.service';
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

/** FR-330 — the whole public catalogue surface shares one short TTL; never applied to `viewer_enrollment` or the signed preview route. */
const PUBLIC_CATALOG_CACHE_TTL_MS = 60_000;

/** Contracts §1 — no auth required on any route here (FR-076, FR-087). */
@ApiTags('Marketplace / Public')
@Controller('marketplace/courses')
export class PublicCatalogController {
  constructor(
    private readonly catalogQuery: CatalogQueryService,
    private readonly courseDetail: CourseDetailService,
    private readonly previewAccess: PreviewAccessService,
    private readonly cache: ApplicationCacheService,
    @InjectRepository(MarketplaceEnrollment)
    private readonly enrollments: Repository<MarketplaceEnrollment>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Listing with search, filters, sort, pagination (FR-076 – FR-082)' })
  public async list(@Query() query: CatalogQueryDto): Promise<CatalogListResult> {
    return this.cache.getOrCompute(
      {
        family: 'marketplace_catalog',
        endpoint: 'list',
        // Fully anonymous and identical for every visitor — the query filters
        // are the whole cache key, never a caller identity (FR-330).
        // `parts` — not `endpoint` — is what `ApplicationCacheService`
        // actually hashes into the cache key (`endpoint` is metrics-only
        // labeling), so the endpoint name is included here explicitly:
        // without it, `list`/`detail`/`curriculum` sharing `family` +
        // `scope` + otherwise-identical `parts` would collide onto the same
        // cache key and one endpoint's cached shape would be served back to
        // a caller of a completely different endpoint.
        scope: 'public',
        parts: ['list', query],
        ttlMs: PUBLIC_CATALOG_CACHE_TTL_MS,
      },
      () => this.catalogQuery.list(query),
    );
  }

  @Get(':slug')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Public course detail (FR-083); 404, never 403, when not visible (FR-087)' })
  public async detail(@Param('slug') slug: string, @GetUser() user: JwtPayload | undefined): Promise<PublicCourseDetailResponse> {
    // Only the anonymous, visitor-independent half of the response is
    // cached. `viewer_enrollment` is this specific caller's own private
    // access state — computed fresh on every request, never cached, so
    // caching this endpoint can never leak one learner's enrollment status
    // into another visitor's (or an anonymous visitor's) cached response.
    const detail = await this.cache.getOrCompute(
      { family: 'marketplace_catalog', endpoint: 'detail', scope: 'public', parts: ['detail', slug], ttlMs: PUBLIC_CATALOG_CACHE_TTL_MS },
      () => this.courseDetail.getBySlug(slug),
    );
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
    return this.cache.getOrCompute(
      { family: 'marketplace_catalog', endpoint: 'curriculum', scope: 'public', parts: ['curriculum', slug], ttlMs: PUBLIC_CATALOG_CACHE_TTL_MS },
      () => this.courseDetail.getCurriculumBySlug(slug),
    );
  }

  @Get(':slug/preview/:lessonId')
  @ApiOperation({ summary: 'Signed playback for a free-preview lesson only (FR-048, FR-084)' })
  public async preview(@Param('slug') slug: string, @Param('lessonId') lessonId: string): Promise<PreviewLessonContent> {
    return this.previewAccess.getPreviewLesson(slug, lessonId);
  }
}
