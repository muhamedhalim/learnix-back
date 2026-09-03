import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { MarketplaceCourse } from '../catalog/entities';
import { MarketplaceEnrollment } from '../commerce/entities';
import { CourseLevel, CourseReviewStatus, MarketplaceCourseStatus, MarketplaceEnrollmentStatus, MarketplaceInstructorStatus } from '../common/enums';
import { MarketplaceCourseReview } from '../reviews/entities';
import type {
  ApplicationCertificationEntry,
  ApplicationEducationEntry,
  ApplicationPortfolioItem,
  ApplicationProfessionalLink,
  ApplicationWorkExperienceEntry,
} from './entities/instructor-application.entity';
import { MarketplaceInstructor } from './entities/marketplace-instructor.entity';

export interface PublicInstructorCourseSummary {
  id: string;
  slug: string;
  title: string;
  title_ar: string | null;
  summary: string;
  summary_ar: string | null;
  cover_image_key: string;
  level: CourseLevel;
  language: string;
  price_minor: number;
  currency: string;
}

/** The exact FR-026 field list — an allowlist, so a future column added to `MarketplaceInstructor` cannot leak here by accident. */
export interface PublicInstructorProfile {
  slug: string;
  display_name: string;
  photo_key: string | null;
  headline: string | null;
  headline_ar: string | null;
  bio: string | null;
  bio_ar: string | null;
  years_of_experience: number;
  education: ApplicationEducationEntry[];
  certifications: ApplicationCertificationEntry[];
  work_experience: ApplicationWorkExperienceEntry[];
  specializations: string[];
  skills: string[];
  teaching_category_ids: string[];
  portfolio_items: ApplicationPortfolioItem[];
  professional_links: ApplicationProfessionalLink[];
  published_courses: PublicInstructorCourseSummary[];
  aggregate_rating: number | null;
  review_count: number;
  learner_count: number;
}

/**
 * FR-026, FR-027, FR-032. A narrow, read-only aggregation across
 * catalog/reviews/commerce for the one public-profile view — not a
 * substitute for those domains' own services, which own the writes and
 * their own richer read APIs once built. Nothing here is instructor- or
 * admin-privileged: every query is already scoped to `published` /
 * `approved` / `active` rows, which is what makes it safe to expose
 * without auth.
 */
@Injectable()
export class PublicInstructorProfileService {
  constructor(
    @InjectRepository(MarketplaceInstructor)
    private readonly instructors: Repository<MarketplaceInstructor>,
    @InjectRepository(MarketplaceCourse)
    private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceCourseReview)
    private readonly reviews: Repository<MarketplaceCourseReview>,
    @InjectRepository(MarketplaceEnrollment)
    private readonly enrollments: Repository<MarketplaceEnrollment>,
  ) {}

  /** `null` for a suspended/withdrawn/nonexistent instructor — the controller turns that into a 404, never a 403 (FR-032). */
  public async getBySlug(slug: string): Promise<PublicInstructorProfile | null> {
    const instructor = await this.instructors.findOne({
      where: { slug, status: MarketplaceInstructorStatus.APPROVED },
    });
    if (!instructor) return null;

    const courses = await this.courses.find({
      where: { instructor_id: instructor.id, status: MarketplaceCourseStatus.PUBLISHED, removed_at: IsNull() },
      order: { first_published_at: 'DESC' },
    });
    const courseIds = courses.map((course) => course.id);

    let aggregateRating: number | null = null;
    let reviewCount = 0;
    let learnerCount = 0;

    if (courseIds.length > 0) {
      const ratingRow = await this.reviews
        .createQueryBuilder('r')
        .select('AVG(r.rating)', 'avg')
        .addSelect('COUNT(*)', 'count')
        .where('r.course_id IN (:...courseIds)', { courseIds })
        .andWhere('r.status = :status', { status: CourseReviewStatus.APPROVED })
        .getRawOne<{ avg: string | null; count: string }>();
      reviewCount = Number(ratingRow?.count ?? 0);
      aggregateRating = ratingRow?.avg ? Math.round(Number(ratingRow.avg) * 100) / 100 : null;

      const learnerRow = await this.enrollments
        .createQueryBuilder('e')
        .select('COUNT(DISTINCT e.learner_id)', 'count')
        .where('e.course_id IN (:...courseIds)', { courseIds })
        .andWhere('e.status = :status', { status: MarketplaceEnrollmentStatus.ACTIVE })
        .getRawOne<{ count: string }>();
      learnerCount = Number(learnerRow?.count ?? 0);
    }

    return {
      slug: instructor.slug,
      display_name: instructor.display_name,
      photo_key: instructor.photo_key,
      headline: instructor.headline,
      headline_ar: instructor.headline_ar,
      bio: instructor.bio,
      bio_ar: instructor.bio_ar,
      years_of_experience: instructor.years_of_experience,
      education: instructor.education,
      certifications: instructor.certifications,
      work_experience: instructor.work_experience,
      specializations: instructor.specializations,
      skills: instructor.skills,
      teaching_category_ids: instructor.teaching_category_ids,
      portfolio_items: instructor.portfolio_items,
      professional_links: instructor.professional_links,
      published_courses: courses.map((course) => ({
        id: course.id,
        slug: course.slug,
        title: course.title,
        title_ar: course.title_ar,
        summary: course.summary,
        summary_ar: course.summary_ar,
        cover_image_key: course.cover_image_key,
        level: course.level,
        language: course.language,
        price_minor: course.price_minor,
        currency: course.currency,
      })),
      aggregate_rating: aggregateRating,
      review_count: reviewCount,
      learner_count: learnerCount,
    };
  }
}
