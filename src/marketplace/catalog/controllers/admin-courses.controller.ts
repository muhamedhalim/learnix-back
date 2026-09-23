import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { InvalidatesCache } from '../../../common/cache/cache-invalidation.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { biBody } from '../../../i18n/error-translator.util';
import type { BunnyVideoMetadata } from '../../../lessons/bunny-stream.service';
import { BunnyStreamService } from '../../../lessons/bunny-stream.service';
import { MarketplaceReasonDto } from '../../common/dto/reason.dto';
import { CourseAuthoringService } from '../course-authoring.service';
import { CourseLifecycleService } from '../course-lifecycle.service';
import { CourseStatusQueryDto } from '../dto/course-query.dto';
import { RejectCourseDto } from '../dto/reject-course.dto';
import type { MarketplaceCourse, MarketplaceCourseLesson, MarketplaceCourseSection } from '../entities';

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
    private readonly bunnyStream: BunnyStreamService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Every course, any state, any instructor, ordered by waiting time (FR-282)' })
  public async list(@Query() query: CourseStatusQueryDto): Promise<MarketplaceCourse[]> {
    return this.authoring.listAllCourses(query.status);
  }

  @Get(':id/content')
  @ApiOperation({ summary: 'Full curriculum exactly as a buyer would see it — every lesson, not just previews (FR-065)' })
  public async getContent(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ course: MarketplaceCourse; sections: (MarketplaceCourseSection & { lessons: MarketplaceCourseLesson[] })[] }> {
    return this.authoring.getCourseWithCurriculum(id);
  }

  /**
   * Not in contracts §5's endpoint table. `getContent` returns bare
   * `video_id`s, which a reviewer cannot actually play — "full content
   * playable" (FR-065, T077's AC) needs a Bunny playback/embed URL, not
   * just the id. Added during T077 alongside the other read-only gaps this
   * phase surfaced; see the discrepancy note in tasks.md.
   */
  @Get(':id/lessons/:lessonId/video')
  @ApiOperation({ summary: 'Bunny playback metadata for one lesson video, so a reviewer can actually play it (FR-065)' })
  public async getLessonVideo(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<BunnyVideoMetadata> {
    const { sections } = await this.authoring.getCourseWithCurriculum(id);
    const lesson = sections.flatMap((section) => section.lessons).find((l) => l.id === lessonId);
    if (!lesson?.video_id) {
      throw new NotFoundException(biBody('No video has been uploaded for this lesson yet', 'لم يتم رفع فيديو لهذا الدرس بعد'));
    }
    return this.bunnyStream.getVideo(lesson.video_id);
  }

  @Post(':id/approve')
  // Writes `marketplace_courses`, `marketplace_course_review_decisions` and `audit_logs`
  // (recordAuditEvent); `admin_dashboard` reads recent audit logs (T031).
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard'])
  @ApiOperation({ summary: 'submitted_for_review → approved (FR-060)' })
  public async approve(@Param('id', ParseUUIDPipe) id: string, @GetUser() admin: JwtPayload): Promise<void> {
    await this.lifecycle.approve(admin.userId, id);
  }

  @Post(':id/reject')
  // Same write set as approve: course row, review decision, `audit_logs` (T031).
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard'])
  @ApiOperation({ summary: 'submitted_for_review → rejected; reasons plus per-item notes (FR-066)' })
  public async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectCourseDto,
    @GetUser() admin: JwtPayload,
  ): Promise<void> {
    await this.lifecycle.reject(admin.userId, id, dto.reasons, dto.item_notes ?? {});
  }

  @Post(':id/unpublish')
  // Writes `marketplace_courses` and `audit_logs` (adminUnpublish -> recordAuditEvent) (T031).
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard'])
  @ApiOperation({ summary: 'published → unpublished; reason mandatory, and audited (FR-068, FR-290)' })
  public async unpublish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarketplaceReasonDto,
    @GetUser() admin: JwtPayload,
  ): Promise<MarketplaceCourse> {
    return this.lifecycle.adminUnpublish(admin.userId, id, dto.reason);
  }
}
