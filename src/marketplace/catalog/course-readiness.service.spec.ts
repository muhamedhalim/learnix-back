import { CourseLevel, LessonContentType } from '../common/enums';
import { CourseReadinessService } from './course-readiness.service';
import type {
  MarketplaceCourse,
  MarketplaceCourseLesson,
  MarketplaceCourseSection,
} from './entities';

function buildCourse(overrides: Partial<MarketplaceCourse> = {}): MarketplaceCourse {
  return {
    id: 'course-1',
    title: 'Test Course',
    summary: 'A summary',
    description: 'A description',
    category_id: 'cat-1',
    level: CourseLevel.BEGINNER,
    language: 'en',
    price_minor: 1000,
    currency: 'EGP',
    cover_image_key: 'covers/1.jpg',
    learning_outcomes: ['Outcome 1'],
    ...overrides,
  } as unknown as MarketplaceCourse;
}

function buildLesson(overrides: Partial<MarketplaceCourseLesson> = {}): MarketplaceCourseLesson {
  return {
    id: `lesson-${Math.random()}`,
    section_id: 'section-1',
    content_type: LessonContentType.TEXT,
    duration_seconds: 60,
    is_free_preview: false,
    is_required_for_completion: true,
    ...overrides,
  } as unknown as MarketplaceCourseLesson;
}

function buildService(
  course: MarketplaceCourse | null,
  sectionCount: number,
  lessonRows: MarketplaceCourseLesson[],
  awsStatus: jest.Mock = jest.fn().mockResolvedValue({ status: 'ready' }),
) {
  const courses = { findOne: jest.fn().mockResolvedValue(course) };
  const sections = { count: jest.fn().mockResolvedValue(sectionCount) };
  const qb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(lessonRows),
  };
  const lessons = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  const awsVideo = { getStatus: awsStatus };
  const service = new CourseReadinessService(
    courses as never,
    sections as never,
    lessons as never,
    awsVideo as never,
  );
  return { service, awsStatus };
}

const READY_LESSONS: MarketplaceCourseLesson[] = [
  buildLesson({ is_required_for_completion: true, is_free_preview: true }),
  buildLesson({ is_required_for_completion: true }),
  buildLesson({ is_required_for_completion: true }),
];

describe('CourseReadinessService', () => {
  it('passes every item for a fully-formed, minimally-complete course', async () => {
    const { service } = buildService(buildCourse(), 1, READY_LESSONS);
    const result = await service.evaluate('course-1');
    expect(result.ready).toBe(true);
    expect(result.items.every((i) => i.passed)).toBe(true);
  });

  it('refuses on a missing title without failing any other item', async () => {
    const { service } = buildService(buildCourse({ title: '' }), 1, READY_LESSONS);
    const result = await service.evaluate('course-1');
    expect(result.ready).toBe(false);
    expect(result.items.find((i) => i.key === 'title')?.passed).toBe(false);
    expect(result.items.filter((i) => i.key !== 'title').every((i) => i.passed)).toBe(true);
  });

  it('refuses when there is no section', async () => {
    const { service } = buildService(buildCourse(), 0, []);
    const result = await service.evaluate('course-1');
    expect(result.items.find((i) => i.key === 'at_least_one_section')?.passed).toBe(false);
  });

  it('refuses below the minimum lesson count (FR-055)', async () => {
    const { service } = buildService(buildCourse(), 1, READY_LESSONS.slice(0, 2));
    const result = await service.evaluate('course-1');
    expect(result.items.find((i) => i.key === 'minimum_lessons')?.passed).toBe(false);
  });

  it('names the zero-required-lesson case distinctly and refuses it (FR-333)', async () => {
    const allOptional = READY_LESSONS.map((l) => ({ ...l, is_required_for_completion: false }));
    const { service } = buildService(buildCourse(), 1, allOptional);
    const result = await service.evaluate('course-1');
    expect(result.ready).toBe(false);
    expect(result.items.find((i) => i.key === 'at_least_one_required_lesson')?.passed).toBe(false);
  });

  it('refuses when there is no free-preview lesson', async () => {
    const noPreview = READY_LESSONS.map((l) => ({ ...l, is_free_preview: false }));
    const { service } = buildService(buildCourse(), 1, noPreview);
    const result = await service.evaluate('course-1');
    expect(result.items.find((i) => i.key === 'at_least_one_free_preview_lesson')?.passed).toBe(
      false,
    );
  });

  it('refuses on empty learning outcomes', async () => {
    const { service } = buildService(buildCourse({ learning_outcomes: [] }), 1, READY_LESSONS);
    const result = await service.evaluate('course-1');
    expect(result.items.find((i) => i.key === 'learning_outcomes')?.passed).toBe(false);
  });

  it('throws when the course does not exist', async () => {
    const { service } = buildService(null, 0, []);
    await expect(service.evaluate('missing')).rejects.toThrow();
  });

  describe('video_lessons_ready (FR-053)', () => {
    const AWS_REF = 'aws:11111111-1111-1111-1111-111111111111';
    const readyFor = async (
      videoLessons: MarketplaceCourseLesson[],
      awsStatus?: jest.Mock,
    ): Promise<boolean | undefined> => {
      const { service } = buildService(buildCourse(), 1, videoLessons, awsStatus);
      return (await service.evaluate('course-1')).items.find((i) => i.key === 'video_lessons_ready')
        ?.passed;
    };

    it('blocks a video lesson with no video at all', async () => {
      const videoLessons = [
        ...READY_LESSONS,
        buildLesson({ content_type: LessonContentType.VIDEO, video_id: null }),
      ];
      expect(await readyFor(videoLessons)).toBe(false);
    });

    it('verifies an AWS video against its asset status', async () => {
      const videoLessons = [
        ...READY_LESSONS,
        buildLesson({ content_type: LessonContentType.VIDEO, video_id: AWS_REF }),
      ];
      expect(
        await readyFor(videoLessons, jest.fn().mockResolvedValue({ status: 'processing' })),
      ).toBe(false);
      expect(await readyFor(videoLessons, jest.fn().mockResolvedValue({ status: 'ready' }))).toBe(
        true,
      );
      expect(
        await readyFor(videoLessons, jest.fn().mockRejectedValue(new Error('not found'))),
      ).toBe(false);
    });

    it('does not accept a reference that is not an AWS asset: the instructor must upload again', async () => {
      const videoLessons = [
        ...READY_LESSONS,
        buildLesson({
          content_type: LessonContentType.VIDEO,
          video_id: 'f3a8-legacy-provider-guid',
        }),
      ];
      const { service, awsStatus } = buildService(buildCourse(), 1, videoLessons);
      const result = await service.evaluate('course-1');
      expect(result.ready).toBe(false);
      expect(result.items.find((i) => i.key === 'video_lessons_ready')?.passed).toBe(false);
      expect(awsStatus).not.toHaveBeenCalled();
    });

    it('passes once every video lesson reports ready', async () => {
      const videoLessons = [
        ...READY_LESSONS,
        buildLesson({ content_type: LessonContentType.VIDEO, video_id: AWS_REF }),
      ];
      expect(await readyFor(videoLessons)).toBe(true);
    });
  });
});
