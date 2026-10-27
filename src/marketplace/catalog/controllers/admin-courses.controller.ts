import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { InvalidatesCache } from '../../../common/cache/cache-invalidation.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { biBody } from '../../../i18n/error-translator.util';
import { AwsVideoService, awsAssetId, isAwsRef } from '../../../video/aws-video.service';
import { PlaybackCookiesInterceptor } from '../../../video/playback-cookies';
import { MarketplaceReasonDto } from '../../common/dto/reason.dto';
import { CourseAuthoringService } from '../course-authoring.service';
import { CourseEditClassifierService } from '../course-edit-classifier.service';
import { CourseLifecycleService } from '../course-lifecycle.service';
import { AdminCourseQueryDto } from '../dto/course-query.dto';
import { RejectCourseDto } from '../dto/reject-course.dto';
import type {
  MarketplaceCourse,
  MarketplaceCourseLesson,
  MarketplaceCourseSection,
} from '../entities';

/** Contracts §5 course block (T070's scope). Permanent removal (FR-054a, T142) and featuring (FR-284, T191) are separate later tasks. */
@ApiTags('Marketplace / Admin — Courses')
@Controller('marketplace/admin/courses')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminCoursesController {
  constructor(
    private readonly authoring: CourseAuthoringService,
    private readonly lifecycle: CourseLifecycleService,
    private readonly editClassifier: CourseEditClassifierService,
    private readonly awsVideo: AwsVideoService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Every course, any state, any instructor, ordered by waiting time (FR-282)',
  })
  public async list(@Query() query: AdminCourseQueryDto): Promise<MarketplaceCourse[]> {
    return this.authoring.listAllCourses(query.status, query.pending_edit);
  }

  @Get(':id/content')
  @ApiOperation({
    summary:
      'Full curriculum exactly as a buyer would see it — every lesson, not just previews (FR-065)',
  })
  public async getContent(@Param('id', ParseUUIDPipe) id: string): Promise<{
    course: MarketplaceCourse;
    sections: (MarketplaceCourseSection & { lessons: MarketplaceCourseLesson[] })[];
  }> {
    return this.authoring.getCourseWithCurriculum(id);
  }

  /**
   * Not in contracts §5's endpoint table. `getContent` returns bare
   * `video_id`s, which a reviewer cannot actually play — "full content
   * playable" (FR-065, T077's AC) needs a signed playback grant, not
   * just the id. Added during T077 alongside the other read-only gaps this
   * phase surfaced; see the discrepancy note in tasks.md.
   */
  @Get(':id/lessons/:lessonId/video')
  @ApiOperation({
    summary: 'Playback grant for one lesson video, so a reviewer can actually play it (FR-065)',
  })
  @UseInterceptors(PlaybackCookiesInterceptor)
  public async getLessonVideo(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<unknown> {
    const { sections } = await this.authoring.getCourseWithCurriculum(id);
    const lesson = sections.flatMap((section) => section.lessons).find((l) => l.id === lessonId);
    if (!lesson?.video_id) {
      throw new NotFoundException(
        biBody('No video has been uploaded for this lesson yet', 'لم يتم رفع فيديو لهذا الدرس بعد'),
      );
    }
    if (!isAwsRef(lesson.video_id)) {
      // A reference to a retired provider: there is nothing to play until the instructor re-uploads.
      throw new NotFoundException(
        biBody('No video has been uploaded for this lesson yet', 'لم يتم رفع فيديو لهذا الدرس بعد'),
      );
    }
    const assetId = awsAssetId(lesson.video_id);
    const asset = await this.awsVideo.getStatus(assetId);
    if (asset.status !== 'ready') return { status: asset.status, platform: 'aws' };
    const grant = await this.awsVideo.grantPlayback(assetId);
    return {
      status: 'ready',
      platform: 'aws',
      hls_url: grant.hls_url,
      expires_at: grant.expires_at,
      playback_cookies: grant.playback_cookies,
    };
  }

  @Post(':id/approve')
  // Writes `marketplace_courses`, `marketplace_course_review_decisions` and `audit_logs`
  // (recordAuditEvent); `admin_dashboard` reads recent audit logs (T031).
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard'])
  @ApiOperation({ summary: 'submitted_for_review → approved (FR-060)' })
  public async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() admin: JwtPayload,
  ): Promise<void> {
    await this.lifecycle.approve(admin.userId, id);
  }

  @Post(':id/reject')
  // Same write set as approve: course row, review decision, `audit_logs` (T031).
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard'])
  @ApiOperation({
    summary: 'submitted_for_review → rejected; reasons plus per-item notes (FR-066)',
  })
  public async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectCourseDto,
    @GetUser() admin: JwtPayload,
  ): Promise<void> {
    await this.lifecycle.reject(admin.userId, id, dto.reasons, dto.item_notes ?? {});
  }

  /**
   * FR-071: a material edit to a published course (price, currency, category, level, language,
   * certificate, or any curriculum change) waits here for a decision. Approval snapshots the working
   * row as the new public version; rejection leaves the public version untouched and tells the
   * instructor why. Until now the pending marker was set but nothing could ever clear it.
   */
  @Post(':id/pending-edit/approve')
  // Course row, snapshot version, review decision and `audit_logs` (T031).
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard'])
  @ApiOperation({ summary: 'Approve the pending material edit of a published course (FR-071)' })
  public async approvePendingEdit(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() admin: JwtPayload,
  ): Promise<void> {
    await this.editClassifier.approvePendingEdit(id, admin.userId);
  }

  @Post(':id/pending-edit/reject')
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard'])
  @ApiOperation({ summary: 'Reject the pending material edit of a published course; reasons mandatory (FR-071)' })
  public async rejectPendingEdit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectCourseDto,
    @GetUser() admin: JwtPayload,
  ): Promise<void> {
    await this.editClassifier.rejectPendingEdit(id, admin.userId, dto.reasons);
  }

  @Post(':id/unpublish')
  // Writes `marketplace_courses` and `audit_logs` (adminUnpublish -> recordAuditEvent) (T031).
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard'])
  @ApiOperation({
    summary: 'published → unpublished; reason mandatory, and audited (FR-068, FR-290)',
  })
  public async unpublish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarketplaceReasonDto,
    @GetUser() admin: JwtPayload,
  ): Promise<MarketplaceCourse> {
    return this.lifecycle.adminUnpublish(admin.userId, id, dto.reason);
  }
}
