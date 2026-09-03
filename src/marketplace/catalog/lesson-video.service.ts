import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { BunnyTusAuthorization, BunnyVideoMetadata } from '../../lessons/bunny-stream.service';
import { BunnyStreamService } from '../../lessons/bunny-stream.service';
import { biBody } from '../../i18n/error-translator.util';
import { MarketplaceCourse, MarketplaceCourseLesson, MarketplaceCourseSection } from './entities';

export interface LessonUploadAuthorization {
  videoId: string;
  tusAuthorization: BunnyTusAuthorization;
}

/**
 * FR-046, FR-053. Reuses the platform's existing Bunny Stream signing
 * service (`LessonsModule`'s `BunnyStreamService`) rather than a second
 * integration — the marketplace never talks to Bunny directly. This
 * service only signs and reports status; `CourseReadinessService` is what
 * turns "still processing" into a submission block (FR-053).
 */
@Injectable()
export class LessonVideoService {
  constructor(
    @InjectRepository(MarketplaceCourse)
    private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceCourseLesson)
    private readonly lessons: Repository<MarketplaceCourseLesson>,
    private readonly bunnyStream: BunnyStreamService,
  ) {}

  /** Creates the Bunny video record, stamps `video_id` on the lesson, and returns short-lived TUS credentials for the browser to upload directly. */
  public async createUploadAuthorization(
    instructorId: string,
    courseId: string,
    lessonId: string,
  ): Promise<LessonUploadAuthorization> {
    const lesson = await this.getOwnedLessonOrThrow(instructorId, courseId, lessonId);
    const created = await this.bunnyStream.createVideo(lesson.title);
    lesson.video_id = created.videoId;
    await this.lessons.save(lesson);
    return { videoId: created.videoId, tusAuthorization: this.bunnyStream.createTusAuthorization(created.videoId) };
  }

  public async getVideoStatus(instructorId: string, courseId: string, lessonId: string): Promise<BunnyVideoMetadata> {
    const lesson = await this.getOwnedLessonOrThrow(instructorId, courseId, lessonId);
    if (!lesson.video_id) {
      throw new NotFoundException(biBody('No video has been uploaded for this lesson yet', 'لم يتم رفع فيديو لهذا الدرس بعد'));
    }
    return this.bunnyStream.getVideo(lesson.video_id);
  }

  /** Finds a lesson by id, verifying (via its section) that it belongs to the given, owned course — no separate section id required from the caller. */
  private async getOwnedLessonOrThrow(instructorId: string, courseId: string, lessonId: string): Promise<MarketplaceCourseLesson> {
    const course = await this.courses.findOne({ where: { id: courseId, instructor_id: instructorId } });
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
