import { FindOperator } from 'typeorm';

import { LessonContentType } from '../common/enums';
import { CourseVersionService } from './course-version.service';
import type { MarketplaceCourse, MarketplaceCourseLesson, MarketplaceCourseSection, MarketplaceCourseVersion } from './entities';

function buildCourse(overrides: Partial<MarketplaceCourse> = {}): MarketplaceCourse {
  return {
    id: 'course-1',
    title: 'Test Course',
    title_ar: null,
    summary: 'Summary',
    summary_ar: null,
    description: 'Description',
    description_ar: null,
    category_id: 'cat-1',
    level: 'beginner',
    language: 'en',
    price_minor: 1000,
    currency: 'EGP',
    cover_image_key: 'covers/1.jpg',
    promo_video_id: null,
    learning_outcomes: ['Outcome'],
    prerequisites: [],
    target_audience: [],
    certificate_enabled: false,
    total_duration_seconds: 120,
    lesson_count: 2,
    ...overrides,
  } as unknown as MarketplaceCourse;
}

function buildService(
  course: MarketplaceCourse | null,
  sectionRows: MarketplaceCourseSection[],
  lessonRows: MarketplaceCourseLesson[],
  existingVersions: MarketplaceCourseVersion[] = [],
) {
  const courses = {
    findOne: jest.fn().mockResolvedValue(course),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const sections = {
    find: jest.fn().mockResolvedValue(sectionRows),
  };
  // T071: lessons are read for all sections at once (`section_id IN (...)`).
  const lessons = {
    find: jest.fn(async ({ where }: { where: { section_id: string | FindOperator<string> } }) => {
      const wanted =
        where.section_id instanceof FindOperator ? (where.section_id.value as string[]) : [where.section_id];
      return lessonRows.filter((l) => wanted.includes(l.section_id));
    }),
  };
  const versions = {
    findOne: jest.fn().mockResolvedValue(
      existingVersions.length > 0 ? existingVersions[existingVersions.length - 1] : null,
    ),
    create: jest.fn((data: Partial<MarketplaceCourseVersion>) => data as MarketplaceCourseVersion),
    save: jest.fn(async (entity: MarketplaceCourseVersion) => ({ id: 'version-new', ...entity })),
  };
  const service = new CourseVersionService(courses as never, sections as never, lessons as never, versions as never);
  return { service, courses, sections, lessons, versions };
}

describe('CourseVersionService', () => {
  it('builds an immutable snapshot from the course and its ordered curriculum', async () => {
    const course = buildCourse();
    const section = { id: 'section-1', title: 'Section 1', title_ar: null, position: 0 } as unknown as MarketplaceCourseSection;
    const lesson = {
      id: 'lesson-1',
      section_id: 'section-1',
      title: 'Lesson 1',
      title_ar: null,
      position: 0,
      content_type: LessonContentType.TEXT,
      video_id: null,
      content_html: null,
      duration_seconds: 60,
      is_free_preview: true,
      is_required_for_completion: false,
    } as unknown as MarketplaceCourseLesson;

    const { service, courses } = buildService(course, [section], [lesson]);
    const result = await service.publishSnapshot('course-1', 'admin-1');

    const snapshot = result.snapshot as unknown as { sections: { lessons: { title: string }[] }[]; title: string };
    expect(snapshot.title).toBe('Test Course');
    expect(snapshot.sections).toHaveLength(1);
    expect(snapshot.sections[0]?.lessons[0]?.title).toBe('Lesson 1');
    expect(courses.update).toHaveBeenCalledWith({ id: 'course-1' }, { current_version_id: 'version-new' });
  });

  it('increments version_number from the last existing version', async () => {
    const course = buildCourse();
    const existing = { id: 'v1', course_id: 'course-1', version_number: 3 } as unknown as MarketplaceCourseVersion;
    const { service } = buildService(course, [], [], [existing]);
    const result = await service.publishSnapshot('course-1', 'admin-1');
    expect(result.version_number).toBe(4);
  });

  it('starts at version 1 when no prior version exists', async () => {
    const course = buildCourse();
    const { service } = buildService(course, [], []);
    const result = await service.publishSnapshot('course-1', 'admin-1');
    expect(result.version_number).toBe(1);
  });

  it('throws when the course does not exist', async () => {
    const { service } = buildService(null, [], []);
    await expect(service.publishSnapshot('missing', 'admin-1')).rejects.toThrow();
  });

  it('T071: reads the lessons of every section in one statement and keeps section and lesson order', async () => {
    const section = (id: string, position: number) =>
      ({ id, title: id, title_ar: null, position }) as unknown as MarketplaceCourseSection;
    const lesson = (id: string, sectionId: string, position: number) =>
      ({
        id,
        section_id: sectionId,
        title: id,
        title_ar: null,
        position,
        content_type: LessonContentType.TEXT,
        video_id: null,
        content_html: null,
        duration_seconds: 60,
        is_free_preview: false,
        is_required_for_completion: true,
      }) as unknown as MarketplaceCourseLesson;
    const { service, lessons, versions } = buildService(
      buildCourse(),
      [section('a', 0), section('b', 1), section('c', 2)],
      // rows as the database returns them: ORDER BY section_id, position
      [lesson('l1', 'a', 0), lesson('l2', 'b', 0), lesson('l3', 'b', 1)],
    );

    await service.publishSnapshot('course-1', 'admin-1');

    expect(lessons.find).toHaveBeenCalledTimes(1);
    const saved = (versions.save.mock.calls[0] as [{ snapshot: { sections: Array<{ id: string; lessons: Array<{ id: string }> }> } }])[0];
    expect(saved.snapshot.sections.map((s) => [s.id, s.lessons.map((l) => l.id)])).toEqual([
      ['a', ['l1']],
      ['b', ['l2', 'l3']],
      ['c', []],
    ]);
  });

});
