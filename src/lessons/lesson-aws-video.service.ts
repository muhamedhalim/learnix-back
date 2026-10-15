import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { biBody } from '../i18n/error-translator.util';
import {
  DirectUploadsService,
  type InitDirectUploadResult,
} from '../uploads/direct/direct-uploads.service';
import { AwsVideoService, type PlaybackGrant } from '../video/aws-video.service';
import { Lesson } from './entities/lesson.entity';

export interface AwsVideoStatus {
  lessonId: string;
  status: 'processing' | 'ready' | 'failed';
  progress: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
}

/**
 * Video for academic lessons: the browser uploads the source straight to S3, MediaConvert builds an
 * HLS ladder, and playback is a CloudFront signed-cookie grant. The lesson row mirrors the asset state
 * in `video_status` (processing | ready | failed).
 */
@Injectable()
export class LessonAwsVideoService {
  constructor(
    @InjectRepository(Lesson) private readonly lessons: Repository<Lesson>,
    private readonly uploads: DirectUploadsService,
    private readonly video: AwsVideoService,
  ) {}

  public isEnabled(): boolean {
    return (
      this.video.isEnabled() &&
      this.uploads.capabilities().purposes.some((p) => p.purpose === 'lesson_video' && p.enabled)
    );
  }

  /** Start a direct upload for this lesson's video. Returns the presigned plan from DirectUploadsService. */
  public async startUpload(
    lessonId: string,
    teacherId: string,
    input: { filename: string; contentType: string; size: number },
  ): Promise<InitDirectUploadResult> {
    await this.ownedLesson(lessonId, teacherId);
    if (!this.isEnabled()) {
      throw new BadRequestException(
        biBody('AWS video upload is not available', 'رفع الفيديو غير متاح حاليًا'),
      );
    }
    return this.uploads.init(teacherId, { purpose: 'lesson_video', ...input });
  }

  /** Verify the upload, start transcoding, and attach the new asset (replacing any previous one). */
  public async completeUpload(
    lessonId: string,
    teacherId: string,
    uploadId: string,
  ): Promise<{ status: 'processing' | 'failed'; assetId: string }> {
    const lesson = await this.ownedLesson(lessonId, teacherId);
    const completed = await this.uploads.complete(teacherId, uploadId);
    if (completed.purpose !== 'lesson_video') {
      throw new BadRequestException(biBody('Wrong upload type', 'نوع الرفع غير صحيح'));
    }

    const asset = await this.video.registerUpload(completed, teacherId);
    const previousAssetId = lesson.video_asset_id;

    lesson.video_asset_id = asset.id;
    lesson.video_status = asset.status === 'failed' ? 'failed' : 'processing';
    lesson.video_thumbnail = null;
    lesson.video_width = null;
    lesson.video_height = null;
    lesson.video_size_bytes = completed.size;
    await this.lessons.save(lesson);

    // The new asset is attached first; only then is the old one removed, so a failure here never
    // leaves the lesson without a video.
    if (previousAssetId !== null && previousAssetId !== asset.id) {
      await this.video.deleteAsset(previousAssetId);
    }
    return { status: asset.status === 'failed' ? 'failed' : 'processing', assetId: asset.id };
  }

  /** Current state, mirrored onto the lesson row so list/detail views stay consistent. */
  public async status(lessonId: string, teacherId: string): Promise<AwsVideoStatus> {
    const lesson = await this.ownedLesson(lessonId, teacherId);
    if (lesson.video_asset_id === null) {
      throw new BadRequestException(
        biBody('This lesson has no video.', 'لا يحتوي هذا الدرس على فيديو.'),
      );
    }
    const asset = await this.video.getStatus(lesson.video_asset_id);
    const status =
      asset.status === 'ready' ? 'ready' : asset.status === 'failed' ? 'failed' : 'processing';

    if (lesson.video_status !== status) {
      lesson.video_status = status;
      if (asset.duration_seconds !== null) lesson.duration = asset.duration_seconds;
      if (asset.width !== null) lesson.video_width = asset.width;
      if (asset.height !== null) lesson.video_height = asset.height;
      await this.lessons.save(lesson);
    }
    return {
      lessonId: lesson.id,
      status,
      progress: status === 'ready' ? 100 : 0,
      durationSeconds: asset.duration_seconds,
      width: asset.width,
      height: asset.height,
      sizeBytes: asset.size_bytes,
    };
  }

  public async remove(lessonId: string, teacherId: string): Promise<void> {
    const lesson = await this.ownedLesson(lessonId, teacherId);
    await this.detach(lesson);
  }

  /** Clear the video fields and delete the stored objects. */
  public async detach(lesson: Lesson): Promise<void> {
    const assetId = lesson.video_asset_id;
    lesson.video_asset_id = null;
    lesson.video_status = null;
    lesson.video_thumbnail = null;
    lesson.video_width = null;
    lesson.video_height = null;
    lesson.video_size_bytes = null;
    await this.lessons.save(lesson);
    if (assetId !== null) await this.video.deleteAsset(assetId);
  }

  /** Playback grant. The caller must already have passed the lesson access policy. */
  public playback(lesson: Lesson): Promise<PlaybackGrant> {
    if (lesson.video_asset_id === null) {
      throw new NotFoundException(
        biBody('This lesson has no ready video.', 'لا يوجد لهذا الدرس فيديو جاهز.'),
      );
    }
    return this.video.grantPlayback(lesson.video_asset_id);
  }

  private async ownedLesson(lessonId: string, teacherId: string): Promise<Lesson> {
    const lesson = await this.lessons.findOne({ where: { id: lessonId } });
    if (lesson === null) {
      throw new NotFoundException(
        biBody(`Lesson with ID ${lessonId} not found`, `الدرس بالمعرّف ${lessonId} غير موجود`),
      );
    }
    if (lesson.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only update your own lessons', 'يمكنك تحديث دروسك الخاصة فقط'),
      );
    }
    return lesson;
  }
}
