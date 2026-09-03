import { getMetadataArgsStorage } from 'typeorm';

import { MarketplaceCategory } from './marketplace-category.entity';
import { MarketplaceCourse } from './marketplace-course.entity';
import { MarketplaceCourseLesson } from './marketplace-course-lesson.entity';
import { MarketplaceCourseRemoval } from './marketplace-course-removal.entity';
import { MarketplaceCourseReviewDecision } from './marketplace-course-review-decision.entity';
import { MarketplaceCourseSection } from './marketplace-course-section.entity';
import { MarketplaceCourseVersion } from './marketplace-course-version.entity';

function columnNames(target: unknown): string[] {
  return getMetadataArgsStorage()
    .columns.filter((c) => c.target === target)
    .map((c) => c.propertyName);
}

describe('MarketplaceCategory entity', () => {
  it('declares the bilingual two-level taxonomy columns (FR-035, FR-036)', () => {
    const names = columnNames(MarketplaceCategory);
    for (const c of ['id', 'parent_id', 'name_en', 'name_ar', 'slug', 'display_order', 'is_active']) {
      expect(names).toContain(c);
    }
  });
});

describe('MarketplaceCourse entity', () => {
  const names = columnNames(MarketplaceCourse);

  it('declares every column data-model.md §2 requires', () => {
    for (const c of [
      'id',
      'instructor_id',
      'category_id',
      'slug',
      'title',
      'level',
      'language',
      'price_minor',
      'currency',
      'status',
      'total_duration_seconds',
      'lesson_count',
      'removed_at',
      'removed_by',
      'removal_reason',
    ]) {
      expect(names).toContain(c);
    }
  });

  it('carries the price and removal check constraints', () => {
    const checkNames = getMetadataArgsStorage()
      .checks.filter((c) => c.target === MarketplaceCourse)
      .map((c) => c.name);
    expect(checkNames).toContain('CHK_mp_courses_price_nonneg');
    expect(checkNames).toContain('CHK_mp_courses_removed');
  });

  it('carries the public-listing partial index scoped to published, non-removed courses', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === MarketplaceCourse && i.name === 'IDX_mp_courses_public',
    );
    expect(index?.where).toContain("'published'");
    expect(index?.where).toContain('removed_at');
  });
});

describe('MarketplaceCourseLesson entity', () => {
  it('requires a positive duration and defaults required-for-completion to true (FR-046, FR-242)', () => {
    const check = getMetadataArgsStorage().checks.find(
      (c) => c.target === MarketplaceCourseLesson && c.name === 'CHK_mp_lessons_duration_positive',
    );
    expect(check).toBeDefined();
    const requiredColumn = getMetadataArgsStorage().columns.find(
      (c) => c.target === MarketplaceCourseLesson && c.propertyName === 'is_required_for_completion',
    );
    expect(requiredColumn?.options.default).toBe(true);
    const previewColumn = getMetadataArgsStorage().columns.find(
      (c) => c.target === MarketplaceCourseLesson && c.propertyName === 'is_free_preview',
    );
    expect(previewColumn?.options.default).toBe(false);
  });
});

describe('MarketplaceCourseSection entity', () => {
  it('enforces one position per course', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === MarketplaceCourseSection && i.name === 'UQ_mp_sections_course_position',
    );
    expect(index?.unique).toBe(true);
  });
});

describe('MarketplaceCourseVersion entity', () => {
  it('is a durable publication snapshot with no update columns', () => {
    const names = columnNames(MarketplaceCourseVersion);
    expect(names).toEqual(
      expect.arrayContaining(['id', 'course_id', 'version_number', 'snapshot', 'published_at', 'published_by']),
    );
  });
});

describe('MarketplaceCourseRemoval entity', () => {
  it('is unique per course — a course is removed at most once (FR-054a)', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === MarketplaceCourseRemoval && i.name === 'UQ_mp_course_removals_course',
    );
    expect(index?.unique).toBe(true);
  });
});

describe('MarketplaceCourseReviewDecision entity', () => {
  it('is distinct from a learner rating and carries the reviewer + reasons', () => {
    const names = columnNames(MarketplaceCourseReviewDecision);
    expect(names).toEqual(
      expect.arrayContaining(['id', 'course_id', 'decision', 'reasons', 'reviewed_by', 'reviewed_at']),
    );
  });
});
