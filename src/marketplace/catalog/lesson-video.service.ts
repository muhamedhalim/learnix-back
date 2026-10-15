import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import {
  DirectUploadsService,
  type InitDirectUploadResult,
} from '../../uploads/direct/direct-uploads.service';
import { AwsVideoService, awsAssetId, isAwsRef, toAwsRef } from '../../video/aws-video.service';
import { MarketplaceCourse, MarketplaceCourseLesson, MarketplaceCourseSection } from './entities';

/** Processing state of a lesson video, as the instructor UI polls it. */
export interface LessonVideoStatus {
  status: 'processing' | 'ready' | 'failed';
  progress: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  thumbnailUrl: string | null;
}

/**
 * FR-046, FR-053. Direct-to-S3 upload bookkeeping and processing status for marketplace lesson
 * videos (S3 -> MediaConvert -> CloudFront signed cookies, via `AwsVideoService`).
 * `CourseReadinessService` is what turns "still processing" into a submission block (FR-053).
 */
@Injectable()
export class LessonVideoService {
  constructor(
    @InjectRepository(MarketplaceCourse)
    private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceCourseLesson)
    private readonly lessons: Repository<MarketplaceCourseLesson>,
    @Optional() private readonly awsVideo?: AwsVideoService,
    @Optional() private readonly directUploads?: DirectUploadsService,
  ) {}

  /** AWS: start a direct-to-S3 upload for this lesson's video (browser uploads straight to S3). */
  public async startAwsUpload(
    instructorId: string,
    userId: string,
    courseId: string,
    lessonId: string,
    input: { filename: string; contentType: string; size: number },
  ): Promise<InitDirectUploadResult> {
    await this.getOwnedLessonOrThrow(instructorId, courseId, lessonId);
    this.assertAwsEnabled();
    // The upload session belongs to the signed-in USER; every later call re-checks that identity.
    return this.directUploads!.init(userId, { purpose: 'lesson_video', ...input });
  }

  /** Whether the AWS video pipeline can take uploads on this deployment. */
  public awsEnabled(): boolean {
    return !!this.awsVideo?.isEnabled() && !!this.directUploads;
  }

  private assertAwsEnabled(): void {
    if (!this.awsVideo?.isEnabled() || !this.directUploads) {
      throw new BadRequestException(
        biBody('Video upload is not available', 'رفع الفيديو غير متاح حاليًا'),
      );
    }
  }

  /** Presigned URLs for specific multipart parts of this lesson's in-progress video upload. */
  public async awsPartUrls(
    instructorId: string,
    userId: string,
    courseId: string,
    lessonId: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<Record<number, string>> {
    await this.getOwnedLessonOrThrow(instructorId, courseId, lessonId);
    this.assertAwsEnabled();
    return this.directUploads!.partUrls(userId, uploadId, partNumbers);
  }

  public async awsListParts(
    instructorId: string,
    userId: string,
    courseId: string,
    lessonId: string,
    uploadId: string,
  ): Promise<Array<{ part_number: number; size: number }>> {
    await this.getOwnedLessonOrThrow(instructorId, courseId, lessonId);
    this.assertAwsEnabled();
    return this.directUploads!.listParts(userId, uploadId);
  }

  public async abortAwsUpload(
    instructorId: string,
    userId: string,
    courseId: string,
    lessonId: string,
    uploadId: string,
  ): Promise<void> {
    await this.getOwnedLessonOrThrow(instructorId, courseId, lessonId);
    this.assertAwsEnabled();
    await this.directUploads!.abort(userId, uploadId);
  }

  /** AWS: verify the upload, start transcoding and point the lesson at the new asset. */
  public async completeAwsUpload(
    instructorId: string,
    userId: string,
    courseId: string,
    lessonId: string,
    uploadId: string,
  ): Promise<{ video_id: string; status: 'processing' | 'failed' }> {
    const lesson = await this.getOwnedLessonOrThrow(instructorId, courseId, lessonId);
    this.assertAwsEnabled();
    const completed = await this.directUploads!.complete(userId, uploadId);
    if (completed.purpose !== 'lesson_video') {
      throw new BadRequestException(biBody('Wrong upload type', 'نوع الرفع غير صحيح'));
    }
    const asset = await this.awsVideo!.registerUpload(completed, userId);
    const previous = lesson.video_id;
    lesson.video_id = toAwsRef(asset.id);
    await this.lessons.save(lesson);
    // Attach first, delete second: a failure never leaves the lesson without a video.
    if (isAwsRef(previous) && previous !== lesson.video_id) {
      await this.awsVideo!.deleteAsset(awsAssetId(previous));
    }
    return {
      video_id: lesson.video_id,
      status: asset.status === 'failed' ? 'failed' : 'processing',
    };
  }

  public async getVideoStatus(
    instructorId: string,
    courseId: string,
    lessonId: string,
  ): Promise<LessonVideoStatus> {
    const lesson = await this.getOwnedLessonOrThrow(instructorId, courseId, lessonId);
    if (!lesson.video_id || !isAwsRef(lesson.video_id)) {
      throw new NotFoundException(
        biBody('No video has been uploaded for this lesson yet', 'لم يتم رفع فيديو لهذا الدرس بعد'),
      );
    }
    const asset = await this.awsVideo!.getStatus(awsAssetId(lesson.video_id));
    return {
      status:
        asset.status === 'ready' ? 'ready' : asset.status === 'failed' ? 'failed' : 'processing',
      progress: asset.status === 'ready' ? 100 : 0,
      durationSeconds: asset.duration_seconds,
      width: asset.width,
      height: asset.height,
      sizeBytes: asset.size_bytes,
      thumbnailUrl: null,
    };
  }

  /** Finds a lesson by id, verifying (via its section) that it belongs to the given, owned course — no separate section id required from the caller. */
  private async getOwnedLessonOrThrow(
    instructorId: string,
    courseId: string,
    lessonId: string,
  ): Promise<MarketplaceCourseLesson> {
    const course = await this.courses.findOne({
      where: { id: courseId, instructor_id: instructorId },
    });
    if (!course) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }
    const lesson = await this.lessons
      .createQueryBuilder('l')
      .innerJoin(MarketplaceCourseSection, 's', 's.id = l.section_id')
      .where('l.id = :lessonId', { lessonId })
      .andWhere('s.course_id = :courseId', { courseId: course.id })
      .getOne();
    if (!lesson) {
      throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
    }
    return lesson;
  }
}
