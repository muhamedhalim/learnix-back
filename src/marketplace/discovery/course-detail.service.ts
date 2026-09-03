import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { getMarketplaceConfig } from '../../config/marketplace.config';
import { biBody } from '../../i18n/error-translator.util';
import type { CourseSnapshot } from '../catalog/course-version.service';
import { CourseVersionService } from '../catalog/course-version.service';
import { MarketplaceCourse } from '../catalog/entities';
import { CourseReviewStatus, MarketplaceEnrollmentStatus } from '../common/enums';
import { MarketplaceEnrollment } from '../commerce/entities';
import { MarketplaceCourseReview } from '../reviews/entities';
import { CatalogQueryService } from './catalog-query.service';

export interface RatingDistribution {
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
}

export interface RelatedCourseSummary {
  id: string;
  slug: string;
  title: string;
  cover_image_key: string;
  price_minor: number;
  currency: string;
}

export interface PublicCourseDetail {
  id: string;
  slug: string;
  snapshot: CourseSnapshot;
  category: { id: string; name_en: string; name_ar: string; slug: string };
  instructor: {
    slug: string;
    display_name: string;
    headline: string | null;
    headline_ar: string | null;
    photo_key: string | null;
    years_of_experience: number;
  };
  enrollment_count: number;
  average_rating: number;
  review_count: number;
  rating_distribution: RatingDistribution;
  refund_window_days: number | null;
  last_update_date: Date;
  first_published_at: Date | null;
  /** FR-089 — drawn only from published courses. */
  related_courses: RelatedCourseSummary[];
}

export interface PublicCourseCurriculum {
  sections: CourseSnapshot['sections'];
}

/**
 * FR-083, FR-089. Content fields (title, description, sections/lessons,
 * pricing, ...) come from the *snapshot* the current `MarketplaceCourseVersion`
 * carries — never the live authoring row — so what a visitor sees matches
 * exactly what a buyer would purchase right now (FR-074/075). Aggregates
 * (rating, enrollment count) are computed live since they are not part of
 * what "stays stable" per purchase.
 */
@Injectable()
export class CourseDetailService {
  constructor(
    @InjectRepository(MarketplaceCourseReview)
    private readonly reviews: Repository<MarketplaceCourseReview>,
    @InjectRepository(MarketplaceEnrollment)
    private readonly enrollments: Repository<MarketplaceEnrollment>,
    private readonly catalogQuery: CatalogQueryService,
    private readonly versions: CourseVersionService,
  ) {}

  public async getBySlug(slug: string): Promise<PublicCourseDetail> {
    const course = await this.findVisibleBySlug(slug);
    const snapshot = await this.currentSnapshot(course);

    const [enrollmentCount, ratingRows, related] = await Promise.all([
      this.enrollments.count({ where: { course_id: course.id, status: MarketplaceEnrollmentStatus.ACTIVE } }),
      this.reviews.find({
        where: { course_id: course.id, status: CourseReviewStatus.APPROVED, withdrawn_at: IsNull() },
        select: ['rating'],
      }),
      this.getRelatedCourses(course.id, course.category_id, course.instructor_id),
    ]);

    const distribution: RatingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const row of ratingRows) {
      const bucket = Math.min(5, Math.max(1, Math.round(row.rating))) as 1 | 2 | 3 | 4 | 5;
      distribution[bucket] += 1;
    }
    const reviewCount = ratingRows.length;
    const averageRating = reviewCount === 0 ? 0 : ratingRows.reduce((sum, r) => sum + r.rating, 0) / reviewCount;

    return {
      id: course.id,
      slug: course.slug,
      snapshot,
      category: {
        id: course.category.id,
        name_en: course.category.name_en,
        name_ar: course.category.name_ar,
        slug: course.category.slug,
      },
      instructor: {
        slug: course.instructor.slug,
        display_name: course.instructor.display_name,
        headline: course.instructor.headline,
        headline_ar: course.instructor.headline_ar,
        photo_key: course.instructor.photo_key,
        years_of_experience: course.instructor.years_of_experience,
      },
      enrollment_count: enrollmentCount,
      average_rating: Math.round(averageRating * 100) / 100,
      review_count: reviewCount,
      rating_distribution: distribution,
      // FR-179: no refund window at all for a free course — there is nothing to refund.
      refund_window_days: course.price_minor > 0 ? getMarketplaceConfig().refundWindowDays : null,
      last_update_date: course.updated_at,
      first_published_at: course.first_published_at,
      related_courses: related.map((c) => ({
        id: c.id,
        slug: c.slug,
        title: c.title,
        cover_image_key: c.cover_image_key,
        price_minor: c.price_minor,
        currency: c.currency,
      })),
    };
  }

  public async getCurriculumBySlug(slug: string): Promise<PublicCourseCurriculum> {
    const course = await this.findVisibleBySlug(slug);
    const snapshot = await this.currentSnapshot(course);
    return { sections: snapshot.sections };
  }

  /** FR-089 — drawn only from published courses, never the instructor's unpublished/pending ones. */
  public async getRelatedCourses(
    excludeCourseId: string,
    categoryId: string,
    instructorId: string,
    limit = 6,
  ): Promise<MarketplaceCourse[]> {
    return this.catalogQuery
      .baseVisibleQuery()
      .andWhere('course.id != :courseId', { courseId: excludeCourseId })
      .andWhere('(course.category_id = :categoryId OR course.instructor_id = :instructorId)', { categoryId, instructorId })
      .orderBy('course.instructor_id = :instructorId', 'DESC')
      .addOrderBy('course.first_published_at', 'DESC')
      .limit(limit)
      .getMany();
  }

  /** FR-087: not-published / removed / suspended-instructor is a 404, exactly like "doesn't exist" — never a 403 that would confirm the row is there. */
  public async findVisibleBySlug(slug: string): Promise<MarketplaceCourse> {
    const course = await this.catalogQuery.baseVisibleQuery().andWhere('course.slug = :slug', { slug }).getOne();
    if (!course) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }
    return course;
  }

  private async currentSnapshot(course: MarketplaceCourse): Promise<CourseSnapshot> {
    if (!course.current_version_id) {
      // Unreachable for a genuinely `published` course (publish() always takes a snapshot first) — defensive only.
      throw new NotFoundException(biBody('Course content not available', 'محتوى الدورة غير متاح'));
    }
    const version = await this.versions.getVersion(course.current_version_id);
    return version.snapshot as unknown as CourseSnapshot;
  }
}
