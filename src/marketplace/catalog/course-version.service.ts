import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { loadLessonsBySection } from './curriculum.util';
import { MarketplaceCourse, MarketplaceCourseLesson, MarketplaceCourseSection, MarketplaceCourseVersion } from './entities';

export interface CourseSnapshot {
  title: string;
  title_ar: string | null;
  summary: string;
  summary_ar: string | null;
  description: string;
  description_ar: string | null;
  category_id: string;
  level: string;
  language: string;
  price_minor: number;
  currency: string;
  cover_image_key: string;
  promo_video_id: string | null;
  learning_outcomes: string[];
  prerequisites: string[];
  target_audience: string[];
  certificate_enabled: boolean;
  total_duration_seconds: number;
  lesson_count: number;
  sections: {
    id: string;
    title: string;
    title_ar: string | null;
    position: number;
    lessons: {
      id: string;
      title: string;
      title_ar: string | null;
      position: number;
      content_type: string;
      video_id: string | null;
      content_html: string | null;
      duration_seconds: number;
      is_free_preview: boolean;
      is_required_for_completion: boolean;
    }[];
  }[];
}

/**
 * FR-074, FR-075. An immutable publication snapshot — what a buyer
 * purchased, and what the public sees for a `published` course, stays
 * stable independent of the instructor's live working copy. Every
 * publish — the first one, a cosmetic edit's immediate republish, or an
 * admin's approval of a pending material edit — goes through
 * {@link publishSnapshot}, so there is exactly one code path that ever
 * creates a version.
 */
@Injectable()
export class CourseVersionService {
  constructor(
    @InjectRepository(MarketplaceCourse)
    private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceCourseSection)
    private readonly sections: Repository<MarketplaceCourseSection>,
    @InjectRepository(MarketplaceCourseLesson)
    private readonly lessons: Repository<MarketplaceCourseLesson>,
    @InjectRepository(MarketplaceCourseVersion)
    private readonly versions: Repository<MarketplaceCourseVersion>,
  ) {}

  public async publishSnapshot(courseId: string, publishedBy: string): Promise<MarketplaceCourseVersion> {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }
    const sections = await this.sections.find({ where: { course_id: courseId }, order: { position: 'ASC' } });
    // One statement for every section's lessons, in section order (T071).
    const lessonsBySection = await loadLessonsBySection(this.lessons, sections);

    const snapshot: CourseSnapshot = {
      title: course.title,
      title_ar: course.title_ar,
      summary: course.summary,
      summary_ar: course.summary_ar,
      description: course.description,
      description_ar: course.description_ar,
      category_id: course.category_id,
      level: course.level,
      language: course.language,
      price_minor: course.price_minor,
      currency: course.currency,
      cover_image_key: course.cover_image_key,
      promo_video_id: course.promo_video_id,
      learning_outcomes: course.learning_outcomes,
      prerequisites: course.prerequisites,
      target_audience: course.target_audience,
      certificate_enabled: course.certificate_enabled,
      total_duration_seconds: course.total_duration_seconds,
      lesson_count: course.lesson_count,
      sections: sections.map((section, index) => ({
        id: section.id,
        title: section.title,
        title_ar: section.title_ar,
        position: section.position,
        lessons: lessonsBySection[index]!.map((lesson) => ({
          id: lesson.id,
          title: lesson.title,
          title_ar: lesson.title_ar,
          position: lesson.position,
          content_type: lesson.content_type,
          video_id: lesson.video_id,
          content_html: lesson.content_html,
          duration_seconds: lesson.duration_seconds,
          is_free_preview: lesson.is_free_preview,
          is_required_for_completion: lesson.is_required_for_completion,
        })),
      })),
    };

    const lastVersion = await this.versions.findOne({
      where: { course_id: courseId },
      order: { version_number: 'DESC' },
    });
    const version = this.versions.create({
      course_id: courseId,
      version_number: (lastVersion?.version_number ?? 0) + 1,
      snapshot: snapshot as unknown as Record<string, unknown>,
      published_by: publishedBy,
    });
    const saved = await this.versions.save(version);
    await this.courses.update({ id: courseId }, { current_version_id: saved.id });
    return saved;
  }

  public async getVersion(versionId: string): Promise<MarketplaceCourseVersion> {
    const version = await this.versions.findOne({ where: { id: versionId } });
    if (!version) {
      throw new NotFoundException(biBody('Course version not found', 'إصدار الدورة غير موجود'));
    }
    return version;
  }
}
