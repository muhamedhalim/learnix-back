import { Injectable, NotFoundException } from '@nestjs/common';

import { biBody } from '../../i18n/error-translator.util';
import { BunnyStreamService } from '../../lessons/bunny-stream.service';
import type { CourseSnapshot } from '../catalog/course-version.service';
import { CourseDetailService } from './course-detail.service';

export interface PreviewLessonContent {
  id: string;
  title: string;
  title_ar: string | null;
  content_type: string;
  duration_seconds: number;
  /** Present for a video lesson — a short-lived signed (when Bunny signing is configured) embed URL. */
  embed_url: string | null;
  /** Present for a text lesson — already sanitised on write (FR-304). */
  content_html: string | null;
}

/**
 * FR-048, FR-084. The only public route into any lesson's content. A
 * lesson that isn't `is_free_preview` is treated exactly like it doesn't
 * exist — 404, not 403 — so this can never be used to fingerprint a
 * course's curriculum. Reads from the same immutable snapshot
 * `CourseDetailService` does, not the live authoring row.
 */
@Injectable()
export class PreviewAccessService {
  constructor(
    private readonly courseDetail: CourseDetailService,
    private readonly bunnyStream: BunnyStreamService,
  ) {}

  public async getPreviewLesson(slug: string, lessonId: string): Promise<PreviewLessonContent> {
    // Throws 404 for any non-visible course before this ever reveals whether the lesson id exists.
    await this.courseDetail.findVisibleBySlug(slug);
    const curriculum = await this.courseDetail.getCurriculumBySlug(slug);
    const lesson = this.findLesson(curriculum.sections, lessonId);

    if (!lesson || !lesson.is_free_preview) {
      throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
    }

    return {
      id: lesson.id,
      title: lesson.title,
      title_ar: lesson.title_ar,
      content_type: lesson.content_type,
      duration_seconds: lesson.duration_seconds,
      embed_url:
        lesson.content_type === 'video' && lesson.video_id
          ? (this.bunnyStream.generateSignedEmbedUrl(lesson.video_id) ?? this.bunnyStream.buildEmbedUrl(lesson.video_id))
          : null,
      content_html: lesson.content_type === 'text' ? lesson.content_html : null,
    };
  }

  private findLesson(
    sections: CourseSnapshot['sections'],
    lessonId: string,
  ): CourseSnapshot['sections'][number]['lessons'][number] | undefined {
    for (const section of sections) {
      const lesson = section.lessons.find((l) => l.id === lessonId);
      if (lesson) return lesson;
    }
    return undefined;
  }
}
