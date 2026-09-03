import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { getMarketplaceConfig } from '../../config/marketplace.config';
import { MarketplaceCourse, MarketplaceCategory } from '../catalog/entities';
import { CourseLevel, CourseReviewStatus, MarketplaceCourseStatus, MarketplaceEnrollmentStatus, MarketplaceInstructorStatus } from '../common/enums';
import { MarketplaceCourseReview } from '../reviews/entities';
import { MarketplaceEnrollment } from '../commerce/entities';
import { CatalogSearchService } from './catalog-search.service';

export type CatalogSort = 'newest' | 'popular' | 'rating' | 'price_asc' | 'price_desc';

export interface CatalogFilters {
  q?: string;
  categoryId?: string;
  level?: CourseLevel;
  language?: string;
  minPriceMinor?: number;
  maxPriceMinor?: number;
  currency?: string;
  freeOnly?: boolean;
  minRating?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  certificateOnly?: boolean;
  sort?: CatalogSort;
  page?: number;
  limit?: number;
}

export interface CatalogListItem {
  id: string;
  slug: string;
  title: string;
  title_ar: string | null;
  cover_image_key: string;
  level: CourseLevel;
  language: string;
  price_minor: number;
  currency: string;
  total_duration_seconds: number;
  lesson_count: number;
  certificate_enabled: boolean;
  category: { id: string; name_en: string; name_ar: string; slug: string };
  instructor: { id: string; display_name: string; slug: string };
  average_rating: number;
  review_count: number;
  enrollment_count: number;
}

export interface CatalogListResult {
  items: CatalogListItem[];
  total: number;
  page: number;
  limit: number;
}

/**
 * FR-076 – FR-082, FR-087, FR-331. The one place the public-catalogue
 * visibility predicate (`published`, not removed, instructor approved) is
 * applied — every other discovery service builds on this query, never
 * re-derives the predicate. Filters and sort keys read the **live**
 * `marketplace_courses` row, the columns `IDX_mp_courses_public` /
 * `IDX_mp_courses_price` were built for; only `CourseDetailService` (T082)
 * reads the immutable version snapshot for a course's actual public
 * content. These briefly disagree only in the narrow window between a
 * material edit on an already-published course (FR-071) and its
 * re-approval — accepted rather than building a second, JSONB-indexed
 * projection table for a gap this narrow.
 */
@Injectable()
export class CatalogQueryService {
  constructor(
    @InjectRepository(MarketplaceCourse)
    private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceCategory)
    private readonly categories: Repository<MarketplaceCategory>,
    private readonly search: CatalogSearchService,
  ) {}

  public async list(filters: CatalogFilters): Promise<CatalogListResult> {
    const config = getMarketplaceConfig();
    const page = Math.max(1, filters.page ?? 1);
    const limit = filters.limit ?? config.defaultPageSize;
    if (limit > config.maxPageSize) {
      throw new BadRequestException(
        biBody(
          `Page size cannot exceed ${config.maxPageSize}`,
          `لا يمكن أن يتجاوز حجم الصفحة ${config.maxPageSize}`,
        ),
      );
    }

    const qb = this.baseVisibleQuery();
    this.applyAggregates(qb);
    await this.applyFilters(qb, filters);
    const keyword = filters.q?.trim();
    const usedRelevance = keyword ? await this.search.applySearch(qb, keyword) : false;
    this.applySort(qb, filters.sort, usedRelevance);

    const total = await qb.getCount();
    const rows = await qb
      .offset((page - 1) * limit)
      .limit(limit)
      .getRawAndEntities();

    const items = rows.entities.map((course, index) => this.toListItem(course, rows.raw[index]!));
    return { items, total, page, limit };
  }

  /** The single definition of "publicly visible course" (FR-062, FR-087) — reused by every discovery query. */
  public baseVisibleQuery(): SelectQueryBuilder<MarketplaceCourse> {
    return this.courses
      .createQueryBuilder('course')
      .innerJoinAndSelect('course.instructor', 'instructor')
      .innerJoinAndSelect('course.category', 'category')
      .where('course.status = :status', { status: MarketplaceCourseStatus.PUBLISHED })
      .andWhere('course.removed_at IS NULL')
      .andWhere('instructor.status = :instructorStatus', { instructorStatus: MarketplaceInstructorStatus.APPROVED });
  }

  private applyAggregates(qb: SelectQueryBuilder<MarketplaceCourse>): void {
    qb.addSelect(
      (sub) =>
        sub
          .select('COALESCE(AVG(r.rating), 0)', 'avg')
          .from(MarketplaceCourseReview, 'r')
          .where('r.course_id = course.id')
          .andWhere('r.status = :approvedReviewStatus')
          .andWhere('r.withdrawn_at IS NULL'),
      'course_average_rating',
    )
      .addSelect(
        (sub) =>
          sub
            .select('COUNT(*)', 'count')
            .from(MarketplaceCourseReview, 'r2')
            .where('r2.course_id = course.id')
            .andWhere('r2.status = :approvedReviewStatus')
            .andWhere('r2.withdrawn_at IS NULL'),
        'course_review_count',
      )
      .addSelect(
        (sub) =>
          sub
            .select('COUNT(*)', 'count')
            .from(MarketplaceEnrollment, 'e')
            .where('e.course_id = course.id')
            .andWhere('e.status != :revokedStatus'),
        'course_enrollment_count',
      )
      .setParameter('approvedReviewStatus', CourseReviewStatus.APPROVED)
      .setParameter('revokedStatus', MarketplaceEnrollmentStatus.REVOKED);
  }

  private async applyFilters(qb: SelectQueryBuilder<MarketplaceCourse>, filters: CatalogFilters): Promise<void> {
    if (filters.categoryId) {
      const children = await this.categories.find({ where: { parent_id: filters.categoryId } });
      const ids = [filters.categoryId, ...children.map((c) => c.id)];
      qb.andWhere('course.category_id IN (:...categoryIds)', { categoryIds: ids });
    }
    if (filters.level) qb.andWhere('course.level = :level', { level: filters.level });
    if (filters.language) qb.andWhere('course.language = :language', { language: filters.language });
    if (filters.currency) qb.andWhere('course.currency = :currency', { currency: filters.currency });
    if (filters.freeOnly) qb.andWhere('course.price_minor = 0');
    if (filters.minPriceMinor !== undefined) qb.andWhere('course.price_minor >= :minPrice', { minPrice: filters.minPriceMinor });
    if (filters.maxPriceMinor !== undefined) qb.andWhere('course.price_minor <= :maxPrice', { maxPrice: filters.maxPriceMinor });
    if (filters.minDurationSeconds !== undefined) {
      qb.andWhere('course.total_duration_seconds >= :minDuration', { minDuration: filters.minDurationSeconds });
    }
    if (filters.maxDurationSeconds !== undefined) {
      qb.andWhere('course.total_duration_seconds <= :maxDuration', { maxDuration: filters.maxDurationSeconds });
    }
    if (filters.certificateOnly) qb.andWhere('course.certificate_enabled = true');
    if (filters.minRating !== undefined) {
      qb.andWhere(
        '(SELECT COALESCE(AVG(r3.rating), 0) FROM marketplace_course_reviews r3 WHERE r3.course_id = course.id AND r3.status = :approvedReviewStatus AND r3.withdrawn_at IS NULL) >= :minRating',
        { minRating: filters.minRating },
      );
    }
  }

  private applySort(qb: SelectQueryBuilder<MarketplaceCourse>, sort: CatalogSort | undefined, usedRelevance: boolean): void {
    // FR-081: total ordering — every branch ends in publication date desc, id desc.
    if (usedRelevance && !sort) {
      qb.addOrderBy('course.first_published_at', 'DESC').addOrderBy('course.id', 'DESC');
      return;
    }
    switch (sort) {
      case 'popular':
        qb.orderBy('course_enrollment_count', 'DESC');
        break;
      case 'rating':
        qb.orderBy('course_average_rating', 'DESC');
        break;
      case 'price_asc':
        qb.orderBy('course.price_minor', 'ASC');
        break;
      case 'price_desc':
        qb.orderBy('course.price_minor', 'DESC');
        break;
      case 'newest':
      default:
        qb.orderBy('course.first_published_at', 'DESC');
        break;
    }
    qb.addOrderBy('course.first_published_at', 'DESC').addOrderBy('course.id', 'DESC');
  }

  private toListItem(course: MarketplaceCourse, raw: Record<string, unknown>): CatalogListItem {
    return {
      id: course.id,
      slug: course.slug,
      title: course.title,
      title_ar: course.title_ar,
      cover_image_key: course.cover_image_key,
      level: course.level,
      language: course.language,
      price_minor: course.price_minor,
      currency: course.currency,
      total_duration_seconds: course.total_duration_seconds,
      lesson_count: course.lesson_count,
      certificate_enabled: course.certificate_enabled,
      category: {
        id: course.category.id,
        name_en: course.category.name_en,
        name_ar: course.category.name_ar,
        slug: course.category.slug,
      },
      instructor: { id: course.instructor.id, display_name: course.instructor.display_name, slug: course.instructor.slug },
      average_rating: Math.round(Number(raw['course_average_rating'] ?? 0) * 100) / 100,
      review_count: Number(raw['course_review_count'] ?? 0),
      enrollment_count: Number(raw['course_enrollment_count'] ?? 0),
    };
  }
}
