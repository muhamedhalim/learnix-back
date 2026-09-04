import type { SanitizationService } from '../../common/sanitization/sanitization.service';
import { CourseLevel, LessonContentType, MarketplaceCourseStatus } from '../common/enums';
import { CourseAuthoringService } from './course-authoring.service';
import type { MarketplaceCourse, MarketplaceCourseLesson, MarketplaceCourseSection } from './entities';

function buildCourse(overrides: Partial<MarketplaceCourse> = {}): MarketplaceCourse {
  return {
    id: 'course-1',
    instructor_id: 'instr-1',
    category_id: 'cat-1',
    slug: 'test-course',
    title: 'Test Course',
    status: MarketplaceCourseStatus.DRAFT,
    lesson_count: 0,
    total_duration_seconds: 0,
    ...overrides,
  } as unknown as MarketplaceCourse;
}

function buildSection(overrides: Partial<MarketplaceCourseSection> = {}): MarketplaceCourseSection {
  return { id: 'section-1', course_id: 'course-1', title: 'Section 1', position: 0, ...overrides } as unknown as MarketplaceCourseSection;
}

function buildLesson(overrides: Partial<MarketplaceCourseLesson> = {}): MarketplaceCourseLesson {
  return {
    id: 'lesson-1',
    section_id: 'section-1',
    title: 'Lesson 1',
    position: 0,
    content_type: LessonContentType.TEXT,
    duration_seconds: 60,
    is_free_preview: false,
    is_required_for_completion: true,
    ...overrides,
  } as unknown as MarketplaceCourseLesson;
}

function buildRepo<T extends { id: string }>(rows: T[]) {
  return {
    rows,
    find: jest.fn(async ({ where }: { where: Record<string, unknown> } = { where: {} }) =>
      rows.filter((r) => Object.entries(where ?? {}).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v)),
    ),
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((r) => Object.entries(where).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v)) ?? null,
    ),
    count: jest.fn(async ({ where }: { where: Record<string, unknown> } = { where: {} }) =>
      rows.filter((r) => Object.entries(where ?? {}).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v)).length,
    ),
    create: jest.fn((data: Partial<T>) => data as T),
    save: jest.fn(async (entity: T) => {
      const idx = rows.findIndex((r) => r.id === entity.id);
      if (idx >= 0) rows[idx] = entity;
      else rows.push({ ...entity, id: entity.id ?? `new-${rows.length + 1}` });
      return entity;
    }),
    remove: jest.fn(async (entity: T) => {
      const idx = rows.findIndex((r) => r.id === entity.id);
      if (idx >= 0) rows.splice(idx, 1);
      return entity;
    }),
    update: jest.fn(async (criteria: { id?: string }, partial: Partial<T>) => {
      const row = rows.find((r) => r.id === criteria.id);
      if (row) Object.assign(row, partial);
    }),
    createQueryBuilder: jest.fn(),
  };
}

function buildService(
  courseRows: MarketplaceCourse[],
  sectionRows: MarketplaceCourseSection[],
  lessonRows: MarketplaceCourseLesson[],
  enrollmentRows: { id: string; course_id: string }[] = [],
) {
  const courses = buildRepo(courseRows);
  const sections = buildRepo(sectionRows);
  const lessons = buildRepo(lessonRows);
  const enrollments = buildRepo(enrollmentRows);

  // A minimal query-builder double good enough for count(), getRawOne() and getOne() on the lessons repo.
  lessons.createQueryBuilder = jest.fn(() => {
    let onlyPreview = false;
    let params: Record<string, unknown> = {};
    const qb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn((_clause: string, p?: Record<string, unknown>) => {
        params = { ...params, ...p };
        return qb;
      }),
      andWhere: jest.fn((clause: string, p?: Record<string, unknown>) => {
        if (clause.includes('is_free_preview')) onlyPreview = true;
        params = { ...params, ...p };
        return qb;
      }),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      getCount: jest.fn(async () => (onlyPreview ? lessonRows.filter((l) => l.is_free_preview).length : lessonRows.length)),
      getRawOne: jest.fn(async () => ({
        count: String(lessonRows.length),
        totalDuration: String(lessonRows.reduce((sum, l) => sum + l.duration_seconds, 0)),
      })),
      getOne: jest.fn(async () => {
        const courseSectionIds = sectionRows.filter((s) => s.course_id === params['courseId']).map((s) => s.id);
        return (
          lessonRows.find(
            (l) => l.id === params['lessonId'] && courseSectionIds.includes(l.section_id),
          ) ?? null
        );
      }),
    };
    return qb;
  }) as never;

  const sanitization = {
    sanitizeBasic: jest.fn((s: string) => s),
    sanitizeStrict: jest.fn((s: string) => s),
  } as unknown as jest.Mocked<SanitizationService>;

  const service = new CourseAuthoringService(
    courses as never,
    sections as never,
    lessons as never,
    enrollments as never,
    sanitization,
  );
  return { service, courses, sections, lessons, enrollments };
}

describe('CourseAuthoringService', () => {
  describe('createCourse / updateCourse', () => {
    it('creates a draft course scoped to the calling instructor', async () => {
      const { service, courses } = buildService([], [], []);
      const result = await service.createCourse('instr-1', {
        title: 'New Course',
        summary: 'A summary',
        description: 'A description',
        category_id: 'cat-1',
        level: CourseLevel.BEGINNER,
        language: 'en',
        price_minor: 1000,
        currency: 'EGP',
        cover_image_key: 'covers/1.jpg',
      });
      expect(result.instructor_id).toBe('instr-1');
      expect(result.status).toBe(MarketplaceCourseStatus.DRAFT);
      expect(courses.save).toHaveBeenCalled();
    });

    it('refuses to fetch or edit a course owned by a different instructor (no IDOR)', async () => {
      const course = buildCourse({ instructor_id: 'instr-1' });
      const { service } = buildService([course], [], []);
      await expect(service.updateCourse('instr-2', 'course-1', { title: 'Hijacked' })).rejects.toThrow();
    });

    it('refuses to edit a course that is submitted_for_review (FR-063)', async () => {
      const course = buildCourse({ status: MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW });
      const { service } = buildService([course], [], []);
      await expect(service.updateCourse('instr-1', 'course-1', { title: 'X' })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'COURSE_NOT_EDITABLE_UNDER_REVIEW' }),
      });
    });

    it('applies a partial update to an editable course', async () => {
      const course = buildCourse({ title: 'Old title' });
      const { service } = buildService([course], [], []);
      const result = await service.updateCourse('instr-1', 'course-1', { title: 'New title' });
      expect(result.title).toBe('New title');
    });
  });

  describe('admin reads (FR-282, FR-065)', () => {
    it('listAllCourses returns every course regardless of owning instructor', async () => {
      const a = buildCourse({ id: 'a', instructor_id: 'instr-1' });
      const b = buildCourse({ id: 'b', instructor_id: 'instr-2' });
      const { service } = buildService([a, b], [], []);
      const result = await service.listAllCourses();
      expect(result.map((c) => c.id).sort()).toEqual(['a', 'b']);
    });

    it('listAllCourses filters by status when given one', async () => {
      const draft = buildCourse({ id: 'a', status: MarketplaceCourseStatus.DRAFT });
      const submitted = buildCourse({ id: 'b', status: MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW });
      const { service } = buildService([draft, submitted], [], []);
      const result = await service.listAllCourses(MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW);
      expect(result.map((c) => c.id)).toEqual(['b']);
    });

    it('getCourseWithCurriculum returns every lesson, not just previews, exactly as a buyer would see it (FR-065)', async () => {
      const course = buildCourse();
      const section = buildSection();
      const lesson = buildLesson({ is_free_preview: false });
      const { service } = buildService([course], [section], [lesson]);
      const result = await service.getCourseWithCurriculum('course-1');
      expect(result.course.id).toBe('course-1');
      expect(result.sections[0]?.lessons[0]?.id).toBe(lesson.id);
    });

    it('getCourseWithCurriculum throws for a nonexistent course', async () => {
      const { service } = buildService([], [], []);
      await expect(service.getCourseWithCurriculum('missing')).rejects.toThrow();
    });
  });

  describe('deleteCourse', () => {
    it('deletes when there are no enrollments (FR-054)', async () => {
      const course = buildCourse();
      const { service, courses } = buildService([course], [], [], []);
      await service.deleteCourse('instr-1', 'course-1');
      expect(courses.remove).toHaveBeenCalledWith(course);
    });

    it('refuses when at least one enrollment exists, querying the real marketplace_enrollments table', async () => {
      const course = buildCourse();
      const { service, courses } = buildService([course], [], [], [{ id: 'enr-1', course_id: 'course-1' }]);
      await expect(service.deleteCourse('instr-1', 'course-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'COURSE_HAS_ENROLLMENTS' }),
      });
      expect(courses.remove).not.toHaveBeenCalled();
    });
  });

  describe('sections', () => {
    it('creates a section appended at the end (position = current count)', async () => {
      const course = buildCourse();
      const existing = buildSection({ id: 'section-existing', position: 0 });
      const { service } = buildService([course], [existing], []);
      const result = await service.createSection('instr-1', 'course-1', { title: 'Section 2' });
      expect(result.position).toBe(1);
    });

    it('reorders sections to match the given id order', async () => {
      const course = buildCourse();
      const a = buildSection({ id: 'a', position: 0 });
      const b = buildSection({ id: 'b', position: 1 });
      const { service, sections } = buildService([course], [a, b], []);
      await service.reorderSections('instr-1', 'course-1', ['b', 'a']);
      expect(b.position).toBe(0);
      expect(a.position).toBe(1);
      expect(sections.update).toHaveBeenCalledTimes(2);
    });

    it('refuses a reorder list that does not match the existing section set exactly', async () => {
      const course = buildCourse();
      const a = buildSection({ id: 'a' });
      const { service } = buildService([course], [a], []);
      await expect(service.reorderSections('instr-1', 'course-1', ['a', 'not-a-real-id'])).rejects.toThrow();
    });

    it('recompacts positions and recomputes course totals after deleting a section', async () => {
      const course = buildCourse();
      const a = buildSection({ id: 'a', position: 0 });
      const b = buildSection({ id: 'b', position: 1 });
      const { service, courses } = buildService([course], [a, b], []);
      await service.deleteSection('instr-1', 'course-1', 'a');
      expect(b.position).toBe(0);
      expect(courses.update).toHaveBeenCalled();
    });
  });

  describe('lessons', () => {
    it('creates a lesson (section_id in the dto — lessons are flat under the course) and recomputes the course’s derived duration and count (FR-047)', async () => {
      const course = buildCourse();
      const section = buildSection();
      const { service, courses } = buildService([course], [section], []);
      await service.createLesson('instr-1', 'course-1', {
        section_id: 'section-1',
        title: 'Intro',
        content_type: LessonContentType.TEXT,
        duration_seconds: 120,
      });
      expect(courses.update).toHaveBeenCalledWith({ id: 'course-1' }, { lesson_count: 1, total_duration_seconds: 120 });
    });

    it('defaults a lesson to required unless it is a free preview (FR-242)', async () => {
      const course = buildCourse();
      const section = buildSection();
      const { service } = buildService([course], [section], []);

      const required = await service.createLesson('instr-1', 'course-1', {
        section_id: 'section-1', title: 'A', content_type: LessonContentType.TEXT, duration_seconds: 60,
      });
      expect(required.is_required_for_completion).toBe(true);

      const preview = await service.createLesson('instr-1', 'course-1', {
        section_id: 'section-1', title: 'B', content_type: LessonContentType.TEXT, duration_seconds: 60, is_free_preview: true,
      });
      expect(preview.is_required_for_completion).toBe(false);
    });

    it('honours an explicit is_required_for_completion override on a free-preview lesson', async () => {
      const course = buildCourse();
      const section = buildSection();
      const { service } = buildService([course], [section], []);
      const lesson = await service.createLesson('instr-1', 'course-1', {
        section_id: 'section-1', title: 'A', content_type: LessonContentType.TEXT, duration_seconds: 60,
        is_free_preview: true, is_required_for_completion: true,
      });
      expect(lesson.is_required_for_completion).toBe(true);
    });

    it('refuses a free-preview lesson beyond the FR-049 bound', async () => {
      const course = buildCourse();
      const section = buildSection();
      // 4 existing lessons, 1 already a preview. Bound at 5 total = max(1, floor(0.2*5))=1 -> capped at 1.
      // Adding a 2nd preview at 5 lessons total should be refused.
      const existingLessons = [
        buildLesson({ id: 'l1', is_free_preview: true }),
        buildLesson({ id: 'l2' }),
        buildLesson({ id: 'l3' }),
        buildLesson({ id: 'l4' }),
      ];
      const { service } = buildService([course], [section], existingLessons);
      await expect(
        service.createLesson('instr-1', 'course-1', {
          section_id: 'section-1', title: 'New preview', content_type: LessonContentType.TEXT, duration_seconds: 60, is_free_preview: true,
        }),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'COURSE_FREE_PREVIEW_BOUND_EXCEEDED' }) });
    });

    it('allows marking an already-free-preview lesson without re-checking the bound (no-op on the flag)', async () => {
      const course = buildCourse();
      const section = buildSection();
      const lesson = buildLesson({ id: 'l1', is_free_preview: true });
      const { service } = buildService([course], [section], [lesson]);
      const result = await service.updateLesson('instr-1', 'course-1', 'l1', { title: 'Renamed' });
      expect(result.title).toBe('Renamed');
    });

    it('refuses to update a lesson belonging to a different course (no IDOR)', async () => {
      const course = buildCourse({ id: 'course-1' });
      const otherSection = buildSection({ id: 'other-section', course_id: 'other-course' });
      const lesson = buildLesson({ id: 'l1', section_id: 'other-section' });
      const { service } = buildService([course], [otherSection], [lesson]);
      await expect(service.updateLesson('instr-1', 'course-1', 'l1', { title: 'Hijacked' })).rejects.toThrow();
    });

    it('reorders lessons within a section', async () => {
      const course = buildCourse();
      const section = buildSection();
      const l1 = buildLesson({ id: 'l1', position: 0 });
      const l2 = buildLesson({ id: 'l2', position: 1 });
      const { service, lessons } = buildService([course], [section], [l1, l2]);
      await service.reorderLessons('instr-1', 'course-1', 'section-1', ['l2', 'l1']);
      expect(l2.position).toBe(0);
      expect(l1.position).toBe(1);
      expect(lessons.update).toHaveBeenCalledTimes(2);
    });

    it('deletes a lesson, recompacts positions and recomputes totals', async () => {
      const course = buildCourse();
      const section = buildSection();
      const l1 = buildLesson({ id: 'l1', position: 0, duration_seconds: 60 });
      const l2 = buildLesson({ id: 'l2', position: 1, duration_seconds: 90 });
      const { service, courses } = buildService([course], [section], [l1, l2]);
      await service.deleteLesson('instr-1', 'course-1', 'l1');
      expect(l2.position).toBe(0);
      expect(courses.update).toHaveBeenLastCalledWith({ id: 'course-1' }, { lesson_count: 1, total_duration_seconds: 90 });
    });
  });
});
