import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { InvalidatesCache } from '../../../common/cache/cache-invalidation.decorator';
import { ApprovedInstructor } from '../../common/decorators/approved-instructor.decorator';
import { CurrentInstructor } from '../../common/decorators/current-instructor.decorator';
import type { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';
import { CourseAuthoringService, type OwnCourseListItem } from '../course-authoring.service';
import { CourseEditClassifierService } from '../course-edit-classifier.service';
import { CourseLifecycleService } from '../course-lifecycle.service';
import { CourseReadinessService, type ReadinessResult } from '../course-readiness.service';
import { CourseStatusQueryDto } from '../dto/course-query.dto';
import { CreateCourseDto, UpdateCourseDto } from '../dto/course.dto';
import type { MarketplaceCourse, MarketplaceCourseLesson, MarketplaceCourseReviewDecision, MarketplaceCourseSection } from '../entities';

/** Contracts §3 course block. FR-300: every query is scoped to the caller's own instructor row, never by a role check. */
@ApiTags('Marketplace / Instructor Courses')
@Controller('marketplace/instructor/courses')
@ApprovedInstructor()
@ApiBearerAuth('JWT-auth')
export class InstructorCoursesController {
  constructor(
    private readonly authoring: CourseAuthoringService,
    private readonly lifecycle: CourseLifecycleService,
    private readonly readiness: CourseReadinessService,
    private readonly editClassifier: CourseEditClassifierService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Own courses, filterable by status (FR-283)' })
  public async list(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Query() query: CourseStatusQueryDto,
  ): Promise<OwnCourseListItem[]> {
    return this.authoring.listOwnCourses(instructor.id, query.status);
  }

  @Post()
  // Writes only marketplace catalogue tables (courses, versions, review decisions); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'Create a draft course (FR-041)' })
  public async create(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Body() dto: CreateCourseDto,
  ): Promise<MarketplaceCourse> {
    return this.authoring.createCourse(instructor.id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Own course detail' })
  public async get(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MarketplaceCourse> {
    return this.authoring.getOwnCourse(instructor.id, id);
  }

  @Patch(':id')
  // Writes only marketplace catalogue tables (courses, versions, review decisions); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'Edit own course; on a published course, classifies the edit as material (FR-071) or cosmetic (FR-072)' })
  public async update(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCourseDto,
  ): Promise<MarketplaceCourse> {
    // Classify what really changed, not which keys the client sent: forms are saved whole.
    const { course, changedFields } = await this.authoring.applyCourseUpdate(instructor.id, id, dto);
    await this.editClassifier.handleCourseFieldEdit(id, changedFields, instructor.id);
    return course;
  }

  @Delete(':id')
  // Writes only marketplace catalogue tables (courses, versions, review decisions); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'Delete own course; refused when it has ever had an enrollment (FR-054)' })
  public async remove(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.authoring.deleteCourse(instructor.id, id);
  }

  @Get(':id/readiness')
  @ApiOperation({ summary: 'Publication checklist with per-item pass/fail (FR-056)' })
  public async readinessCheck(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReadinessResult> {
    await this.authoring.getOwnCourse(instructor.id, id);
    return this.readiness.evaluate(id);
  }

  /**
   * Not in contracts §3's endpoint table — added to unblock the curriculum
   * editor (T073), which has no other way to load a course's existing
   * sections/lessons (the mutation-only section/lesson routes there don't
   * cover a read). Ownership is checked the same IDOR-safe way every other
   * handler here does, via `getOwnCourse`'s scoped query, before reusing
   * `getCourseWithCurriculum` — already written for T070's admin content
   * view — rather than duplicating the section/lesson fetch.
   */
  @Get(':id/curriculum')
  @ApiOperation({ summary: "Own course's sections and lessons, as authored" })
  public async getCurriculum(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ course: MarketplaceCourse; sections: (MarketplaceCourseSection & { lessons: MarketplaceCourseLesson[] })[] }> {
    await this.authoring.getOwnCourse(instructor.id, id);
    return this.authoring.getCourseWithCurriculum(id);
  }

  @Get(':id/review-decisions')
  @ApiOperation({ summary: 'Every admin decision on this course, newest first — reasons and per-item notes (FR-066)' })
  public async listReviewDecisions(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MarketplaceCourseReviewDecision[]> {
    return this.lifecycle.listOwnDecisions(instructor.id, id);
  }

  @Post(':id/submit')
  // Writes only marketplace catalogue tables (courses, versions, review decisions); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'draft|rejected → submitted_for_review; 422 lists every unmet readiness item (FR-056, FR-063)' })
  public async submit(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MarketplaceCourse> {
    return this.lifecycle.submit(instructor.id, id);
  }

  @Post(':id/publish')
  // Writes only marketplace catalogue tables (courses, versions, review decisions); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'approved → published; instructor only (FR-067)' })
  public async publish(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MarketplaceCourse> {
    return this.lifecycle.publish(instructor.id, id);
  }

  @Post(':id/unpublish')
  // Writes only marketplace catalogue tables (courses, versions, review decisions); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'published → unpublished; existing access is never withdrawn (FR-069)' })
  public async unpublish(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MarketplaceCourse> {
    await this.authoring.getOwnCourse(instructor.id, id);
    return this.lifecycle.unpublish(id);
  }

  @Post(':id/republish')
  // Writes only marketplace catalogue tables (courses, versions, review decisions); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'unpublished → published, when still approved (FR-060)' })
  public async republish(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MarketplaceCourse> {
    return this.lifecycle.republish(instructor.id, id);
  }

  @Post(':id/reopen-for-edit')
  // Writes only marketplace catalogue tables (courses, versions, review decisions); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'unpublished → draft, reopened for a fresh edit/submit cycle (FR-060)' })
  public async reopenForEdit(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MarketplaceCourse> {
    return this.lifecycle.reopenForEdit(instructor.id, id);
  }
}
