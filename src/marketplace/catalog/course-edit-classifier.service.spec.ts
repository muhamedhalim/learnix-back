import type { CourseVersionService } from './course-version.service';
import { MarketplaceCourseStatus } from '../common/enums';
import { CourseEditClassifierService } from './course-edit-classifier.service';
import type { MarketplaceCourse } from './entities';

function buildCourse(overrides: Partial<MarketplaceCourse> = {}): MarketplaceCourse {
  return {
    id: 'course-1',
    status: MarketplaceCourseStatus.PUBLISHED,
    pending_review_since: null,
    ...overrides,
  } as unknown as MarketplaceCourse;
}

function buildService(course: MarketplaceCourse | null) {
  const courses = {
    findOne: jest.fn().mockResolvedValue(course),
    update: jest.fn(async (_criteria: unknown, partial: Partial<MarketplaceCourse>) => {
      if (course) Object.assign(course, partial);
      return { affected: course ? 1 : 0 };
    }),
  };
  const decisions = {
    create: jest.fn((data: unknown) => data),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const versions = {
    publishSnapshot: jest.fn().mockResolvedValue({ id: 'version-1', version_number: 1 }),
  } as unknown as jest.Mocked<CourseVersionService>;
  const service = new CourseEditClassifierService(courses as never, decisions as never, versions);
  return { service, courses, decisions, versions };
}

describe('CourseEditClassifierService', () => {
  describe('classifyCourseFieldEdit (FR-070)', () => {
    it.each([
      ['price_minor'],
      ['currency'],
      ['category_id'],
      ['level'],
      ['language'],
      ['certificate_enabled'],
    ] as const)('classifies %s as material', (field) => {
      const { service } = buildService(null);
      expect(service.classifyCourseFieldEdit([field])).toBe('material');
    });

    it.each([
      ['title'],
      ['title_ar'],
      ['summary'],
      ['description'],
      ['cover_image_key'],
      ['learning_outcomes'],
      ['prerequisites'],
      ['target_audience'],
    ] as const)('classifies %s as cosmetic', (field) => {
      const { service } = buildService(null);
      expect(service.classifyCourseFieldEdit([field])).toBe('cosmetic');
    });

    it('classifies a mixed edit set as material if any one field is material', () => {
      const { service } = buildService(null);
      expect(service.classifyCourseFieldEdit(['title', 'price_minor'])).toBe('material');
    });
  });

  describe('handleCourseFieldEdit', () => {
    it('is a no-op for a non-published course', async () => {
      const { service, versions, courses } = buildService(buildCourse({ status: MarketplaceCourseStatus.DRAFT }));
      await service.handleCourseFieldEdit('course-1', ['title'], 'instr-1');
      expect(versions.publishSnapshot).not.toHaveBeenCalled();
      expect(courses.update).not.toHaveBeenCalled();
    });

    it('cosmetic edit on a published course publishes a fresh snapshot immediately (FR-072)', async () => {
      const { service, versions, courses } = buildService(buildCourse());
      await service.handleCourseFieldEdit('course-1', ['title'], 'instr-1');
      expect(versions.publishSnapshot).toHaveBeenCalledWith('course-1', 'instr-1');
      expect(courses.update).not.toHaveBeenCalled();
    });

    it('material edit on a published course sets pending_review_since without touching the live snapshot (FR-071)', async () => {
      const course = buildCourse();
      const { service, versions } = buildService(course);
      await service.handleCourseFieldEdit('course-1', ['price_minor'], 'instr-1');
      expect(versions.publishSnapshot).not.toHaveBeenCalled();
      expect(course.pending_review_since).toBeInstanceOf(Date);
    });

    it('a free↔paid transition (a price_minor edit) on a published course requires a fresh review cycle, existing enrollments untouched by this call (FR-120, T116)', async () => {
      // FR-120's rule is exactly FR-070's existing price_minor-is-material
      // rule applied to the free/paid boundary specifically — a price
      // change from/to 0 is still just a price_minor edit, no special-cased
      // "free/paid" branch needed. This service never reads or writes
      // MarketplaceEnrollment at all (see its constructor), so "existing
      // enrollments unaffected" is a property of that omission, not
      // something this call could violate even if it tried.
      const course = buildCourse();
      const { service, versions } = buildService(course);
      await service.handleCourseFieldEdit('course-1', ['price_minor'], 'instr-1');
      expect(versions.publishSnapshot).not.toHaveBeenCalled();
      expect(course.pending_review_since).toBeInstanceOf(Date);
    });

    it('does not push back the pending-since timestamp on a second material edit before review', async () => {
      const firstTimestamp = new Date('2026-01-01T00:00:00Z');
      const course = buildCourse({ pending_review_since: firstTimestamp });
      const { service, courses } = buildService(course);
      await service.handleCourseFieldEdit('course-1', ['currency'], 'instr-1');
      expect(courses.update).not.toHaveBeenCalled();
      expect(course.pending_review_since).toBe(firstTimestamp);
    });
  });

  describe('handleCurriculumEdit', () => {
    it('always marks a published course pending — curriculum edits have no cosmetic branch (FR-070)', async () => {
      const course = buildCourse();
      const { service } = buildService(course);
      await service.handleCurriculumEdit('course-1');
      expect(course.pending_review_since).toBeInstanceOf(Date);
    });
  });

  describe('approvePendingEdit / rejectPendingEdit', () => {
    it('approval publishes a new snapshot, clears the pending marker, and records the decision', async () => {
      const course = buildCourse({ pending_review_since: new Date() });
      const { service, versions, decisions } = buildService(course);
      await service.approvePendingEdit('course-1', 'admin-1');
      expect(versions.publishSnapshot).toHaveBeenCalledWith('course-1', 'admin-1');
      expect(course.pending_review_since).toBeNull();
      expect(decisions.create).toHaveBeenCalledWith(expect.objectContaining({ decision: 'approved' }));
    });

    it('rejection clears the pending marker without publishing anything new', async () => {
      const course = buildCourse({ pending_review_since: new Date() });
      const { service, versions, decisions } = buildService(course);
      await service.rejectPendingEdit('course-1', 'admin-1', ['Price change not justified']);
      expect(versions.publishSnapshot).not.toHaveBeenCalled();
      expect(course.pending_review_since).toBeNull();
      expect(decisions.create).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'rejected', reasons: ['Price change not justified'] }),
      );
    });

    it('refuses to decide a course with nothing pending', async () => {
      const { service } = buildService(buildCourse({ pending_review_since: null }));
      await expect(service.approvePendingEdit('course-1', 'admin-1')).rejects.toThrow();
    });
  });
});
