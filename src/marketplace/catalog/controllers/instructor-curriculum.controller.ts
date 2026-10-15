import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { InvalidatesCache } from '../../../common/cache/cache-invalidation.decorator';
import { ApprovedInstructor } from '../../common/decorators/approved-instructor.decorator';
import { CurrentInstructor } from '../../common/decorators/current-instructor.decorator';
import type { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';
import { CourseAuthoringService } from '../course-authoring.service';
import { CourseEditClassifierService } from '../course-edit-classifier.service';
import {
  CreateSectionDto,
  ReorderDto,
  ReorderLessonsDto,
  UpdateSectionDto,
} from '../dto/course.dto';
import { CreateLessonDto, UpdateLessonDto } from '../dto/lesson.dto';
import type { MarketplaceCourseLesson, MarketplaceCourseSection } from '../entities';
import type { LessonVideoStatus } from '../lesson-video.service';
import { LessonVideoService } from '../lesson-video.service';

export class StartInstructorVideoUploadDto {
  @IsString()
  @MaxLength(255)
  public filename!: string;

  @IsString()
  @MaxLength(150)
  public content_type!: string;

  @IsInt()
  @Min(1)
  public size!: number;
}

export class InstructorPartUrlsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(10_000, { each: true })
  public part_numbers!: number[];
}

export class CompleteInstructorVideoUploadDto {
  @IsUUID()
  public upload_id!: string;
}

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
  // Writes only marketplace course/section/lesson rows (+ course totals/pending marker); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
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
  // Writes only marketplace course/section/lesson rows (+ course totals/pending marker); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
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
  // Writes only marketplace course/section/lesson rows (+ course totals/pending marker); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
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
  // Writes only marketplace course/section/lesson rows (+ course totals/pending marker); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
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
  // Writes only marketplace course/section/lesson rows (+ course totals/pending marker); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
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
  // Writes only marketplace course/section/lesson rows (+ course totals/pending marker); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
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
  // Writes only marketplace course/section/lesson rows (+ course totals/pending marker); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
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
  // Writes only marketplace course/section/lesson rows (+ course totals/pending marker); no audit log (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'Reorder the lessons within one section (FR-045)' })
  public async reorderLessons(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Body() dto: ReorderLessonsDto,
  ): Promise<void> {
    await this.authoring.reorderLessons(instructor.id, courseId, dto.section_id, dto.ordered_ids);
    await this.editClassifier.handleCurriculumEdit(courseId);
  }

  @Get('video-upload/capabilities')
  @ApiOperation({ summary: 'Is direct-to-S3 video upload available?' })
  public awsVideoCapabilities(): { enabled: boolean } {
    return { enabled: this.lessonVideo.awsEnabled() };
  }

  /** AWS: presigned/multipart plan so the browser uploads the source video straight to S3. */
  @Post('lessons/:lessonId/video-upload/aws')
  @ApiOperation({ summary: 'Start a direct-to-S3 video upload for a lesson' })
  public async startAwsVideoUpload(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: StartInstructorVideoUploadDto,
  ): Promise<unknown> {
    return this.lessonVideo.startAwsUpload(instructor.id, instructor.user_id, courseId, lessonId, {
      filename: dto.filename,
      contentType: dto.content_type,
      size: dto.size,
    });
  }

  @Post('lessons/:lessonId/video-upload/aws/:uploadId/parts')
  @HttpCode(200)
  @ApiOperation({ summary: 'Presigned URLs for specific multipart parts' })
  public async awsPartUrls(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
    @Body() dto: InstructorPartUrlsDto,
  ): Promise<{ urls: Record<number, string> }> {
    return {
      urls: await this.lessonVideo.awsPartUrls(
        instructor.id,
        instructor.user_id,
        courseId,
        lessonId,
        uploadId,
        dto.part_numbers,
      ),
    };
  }

  @Get('lessons/:lessonId/video-upload/aws/:uploadId/parts')
  @ApiOperation({ summary: 'Parts already stored (resume an interrupted upload)' })
  public async awsListParts(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
  ): Promise<{ parts: Array<{ part_number: number; size: number }> }> {
    return {
      parts: await this.lessonVideo.awsListParts(
        instructor.id,
        instructor.user_id,
        courseId,
        lessonId,
        uploadId,
      ),
    };
  }

  @Post('lessons/:lessonId/video-upload/aws/:uploadId/abort')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancel an in-progress video upload' })
  public async awsAbort(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
  ): Promise<void> {
    await this.lessonVideo.abortAwsUpload(
      instructor.id,
      instructor.user_id,
      courseId,
      lessonId,
      uploadId,
    );
  }

  @Post('lessons/:lessonId/video-upload/aws/complete')
  @HttpCode(200)
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({
    summary: 'Verify the uploaded video, start processing and attach it to the lesson',
  })
  public async completeAwsVideoUpload(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: CompleteInstructorVideoUploadDto,
  ): Promise<unknown> {
    return this.lessonVideo.completeAwsUpload(
      instructor.id,
      instructor.user_id,
      courseId,
      lessonId,
      dto.upload_id,
    );
  }

  @Get('lessons/:lessonId/video-status')
  @ApiOperation({ summary: 'Poll processing status for an uploaded lesson video (FR-053)' })
  public async getVideoStatus(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<LessonVideoStatus> {
    return this.lessonVideo.getVideoStatus(instructor.id, courseId, lessonId);
  }
}
