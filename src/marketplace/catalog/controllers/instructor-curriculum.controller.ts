import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApprovedInstructor } from '../../common/decorators/approved-instructor.decorator';
import { CurrentInstructor } from '../../common/decorators/current-instructor.decorator';
import type { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';
import type { BunnyVideoMetadata } from '../../../lessons/bunny-stream.service';
import { CourseAuthoringService } from '../course-authoring.service';
import { CourseEditClassifierService } from '../course-edit-classifier.service';
import { CreateSectionDto, ReorderDto, ReorderLessonsDto, UpdateSectionDto } from '../dto/course.dto';
import { CreateLessonDto, UpdateLessonDto } from '../dto/lesson.dto';
import type { MarketplaceCourseLesson, MarketplaceCourseSection } from '../entities';
import type { LessonUploadAuthorization } from '../lesson-video.service';
import { LessonVideoService } from '../lesson-video.service';

/**
 * Contracts §3 curriculum block. FR-045: sections and lessons, ordered,
 * addable/renamable/reorderable/removable. Every curriculum mutation on an
 * already-`published` course is material by FR-070 — there is no cosmetic
 * curriculum edit — so each handler reports it to
 * `CourseEditClassifierService` after the write succeeds.
 */
@ApiTags('Marketplace / Instructor Curriculum')
@Controller('marketplace/instructor/courses/:courseId')
@ApprovedInstructor()
@ApiBearerAuth('JWT-auth')
export class InstructorCurriculumController {
  constructor(
    private readonly authoring: CourseAuthoringService,
    private readonly editClassifier: CourseEditClassifierService,
    private readonly lessonVideo: LessonVideoService,
  ) {}

  // ------------------------------------------------------------ sections

  @Post('sections')
  @ApiOperation({ summary: 'Add a curriculum section' })
  public async createSection(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Body() dto: CreateSectionDto,
  ): Promise<MarketplaceCourseSection> {
    const section = await this.authoring.createSection(instructor.id, courseId, dto);
    await this.editClassifier.handleCurriculumEdit(courseId);
    return section;
  }

  @Patch('sections/:sectionId')
  @ApiOperation({ summary: 'Rename a section' })
  public async updateSection(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
    @Body() dto: UpdateSectionDto,
  ): Promise<MarketplaceCourseSection> {
    const section = await this.authoring.updateSection(instructor.id, courseId, sectionId, dto);
    await this.editClassifier.handleCurriculumEdit(courseId);
    return section;
  }

  @Delete('sections/:sectionId')
  @ApiOperation({ summary: 'Remove a section and its lessons' })
  public async deleteSection(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
  ): Promise<void> {
    await this.authoring.deleteSection(instructor.id, courseId, sectionId);
    await this.editClassifier.handleCurriculumEdit(courseId);
  }

  @Post('sections/reorder')
  @ApiOperation({ summary: 'Reorder sections (FR-045)' })
  public async reorderSections(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Body() dto: ReorderDto,
  ): Promise<void> {
    await this.authoring.reorderSections(instructor.id, courseId, dto.ordered_ids);
    await this.editClassifier.handleCurriculumEdit(courseId);
  }

  // ------------------------------------------------------------- lessons

  @Post('lessons')
  @ApiOperation({ summary: 'Add a lesson; durationSeconds required (FR-046)' })
  public async createLesson(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Body() dto: CreateLessonDto,
  ): Promise<MarketplaceCourseLesson> {
    const lesson = await this.authoring.createLesson(instructor.id, courseId, dto);
    await this.editClassifier.handleCurriculumEdit(courseId);
    return lesson;
  }

  @Patch('lessons/:lessonId')
  @ApiOperation({ summary: 'Edit a lesson' })
  public async updateLesson(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: UpdateLessonDto,
  ): Promise<MarketplaceCourseLesson> {
    const lesson = await this.authoring.updateLesson(instructor.id, courseId, lessonId, dto);
    await this.editClassifier.handleCurriculumEdit(courseId);
    return lesson;
  }

  @Delete('lessons/:lessonId')
  @ApiOperation({ summary: 'Remove a lesson' })
  public async deleteLesson(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<void> {
    await this.authoring.deleteLesson(instructor.id, courseId, lessonId);
    await this.editClassifier.handleCurriculumEdit(courseId);
  }

  @Post('lessons/reorder')
  @ApiOperation({ summary: 'Reorder the lessons within one section (FR-045)' })
  public async reorderLessons(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Body() dto: ReorderLessonsDto,
  ): Promise<void> {
    await this.authoring.reorderLessons(instructor.id, courseId, dto.section_id, dto.ordered_ids);
    await this.editClassifier.handleCurriculumEdit(courseId);
  }

  @Post('lessons/:lessonId/video-upload')
  @ApiOperation({ summary: 'Bunny TUS signing — reuses the existing signing service' })
  public async createVideoUpload(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<LessonUploadAuthorization> {
    return this.lessonVideo.createUploadAuthorization(instructor.id, courseId, lessonId);
  }

  @Get('lessons/:lessonId/video-status')
  @ApiOperation({ summary: 'Poll Bunny processing status for an uploaded lesson video (FR-053)' })
  public async getVideoStatus(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<BunnyVideoMetadata> {
    return this.lessonVideo.getVideoStatus(instructor.id, courseId, lessonId);
  }
}
