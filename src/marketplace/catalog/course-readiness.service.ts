import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AwsVideoService, awsAssetId, isAwsRef } from '../../video/aws-video.service';
import { getMarketplaceConfig } from '../../config/marketplace.config';
import { biBody } from '../../i18n/error-translator.util';
import { LessonContentType } from '../common/enums';
import { CurrencyRegistryService } from '../common/currency-registry.service';
import { MarketplaceCourse, MarketplaceCourseLesson, MarketplaceCourseSection } from './entities';

export interface ReadinessItem {
  key: string;
  passed: boolean;
}

export interface ReadinessResult {
  ready: boolean;
  items: ReadinessItem[];
}

/**
 * FR-055, FR-056, FR-333. Every item is evaluated and returned — never
 * short-circuited — so a caller (the readiness endpoint, or
 * `CourseLifecycleService.submit()`) always sees the full per-item
 * pass/fail picture, not just the first failure.
 */
@Injectable()
export class CourseReadinessService {
  constructor(
    @InjectRepository(MarketplaceCourse)
    private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceCourseSection)
    private readonly sections: Repository<MarketplaceCourseSection>,
    @InjectRepository(MarketplaceCourseLesson)
    private readonly lessons: Repository<MarketplaceCourseLesson>,
    private readonly currencies: CurrencyRegistryService,
    @Optional() private readonly awsVideo?: AwsVideoService,
  ) {}

  public async evaluate(courseId: string): Promise<ReadinessResult> {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }
    const config = getMarketplaceConfig();

    const sectionCount = await this.sections.count({ where: { course_id: courseId } });
    const lessonRows =
      sectionCount === 0
        ? []
        : await this.lessons
            .createQueryBuilder('l')
            .innerJoin(MarketplaceCourseSection, 's', 's.id = l.section_id')
            .where('s.course_id = :courseId', { courseId })
            .getMany();

    const totalLessons = lessonRows.length;
    const requiredLessons = lessonRows.filter((l) => l.is_required_for_completion).length;
    const previewLessons = lessonRows.filter((l) => l.is_free_preview).length;

    const items: ReadinessItem[] = [
      { key: 'title', passed: !!course.title?.trim() },
      { key: 'summary', passed: !!course.summary?.trim() },
      { key: 'description', passed: !!course.description?.trim() },
      { key: 'category', passed: !!course.category_id },
      { key: 'level', passed: !!course.level },
      { key: 'language', passed: !!course.language?.trim() },
      {
        key: 'price',
        passed:
          course.price_minor !== null &&
          course.price_minor !== undefined &&
          course.price_minor >= 0 &&
          (await this.priceAllowed(course)),
      },
      { key: 'currency', passed: !!course.currency?.trim() && (await this.currencyEnabled(course.currency)) },
      { key: 'cover_image', passed: !!course.cover_image_key?.trim() },
      { key: 'at_least_one_section', passed: sectionCount >= 1 },
      { key: 'minimum_lessons', passed: totalLessons >= config.minLessonsForPublication },
      /** FR-333 — named distinctly, though it is the same underlying count as `minimum_required_lessons` below. */
      {
        key: 'at_least_one_required_lesson',
        passed: requiredLessons >= config.minRequiredLessonsForPublication,
      },
      { key: 'at_least_one_free_preview_lesson', passed: previewLessons >= 1 },
      { key: 'learning_outcomes', passed: (course.learning_outcomes?.length ?? 0) > 0 },
      { key: 'video_lessons_ready', passed: await this.allVideoLessonsReady(lessonRows) },
    ];

    return { ready: items.every((item) => item.passed), items };
  }

  /** FR-325: only a currency the registry has enabled can be sold or paid out in. */
  private async currencyEnabled(code: string): Promise<boolean> {
    try {
      await this.currencies.resolve(code);
      return true;
    } catch {
      return false;
    }
  }

  /** A paid price must sit inside its currency's bounds; zero is always allowed (FR-057). */
  private async priceAllowed(course: MarketplaceCourse): Promise<boolean> {
    if (course.price_minor === 0) return true;
    try {
      await this.currencies.assertPriceInBounds(course.currency, course.price_minor);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * FR-053: a video lesson blocks submission until its video has finished
   * transcoding. A lesson whose video is not an AWS asset (no video, or a reference left over from
   * a retired provider) is not ready: the instructor has to upload it again.
   */
  private async allVideoLessonsReady(lessonRows: MarketplaceCourseLesson[]): Promise<boolean> {
    const videoLessons = lessonRows.filter((l) => l.content_type === LessonContentType.VIDEO);
    if (videoLessons.length === 0) return true;

    const statuses = await Promise.all(
      videoLessons.map(async (lesson) => {
        if (!lesson.video_id) return false;
        if (!isAwsRef(lesson.video_id)) return false;
        const asset = await this.awsVideo?.getStatus(awsAssetId(lesson.video_id)).catch(() => null);
        return asset?.status === 'ready';
      }),
    );
    return statuses.every(Boolean);
  }
}
