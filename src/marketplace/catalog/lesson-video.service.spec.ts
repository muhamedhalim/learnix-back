import type { BunnyStreamService } from '../../lessons/bunny-stream.service';
import { LessonVideoService } from './lesson-video.service';
import type { MarketplaceCourse, MarketplaceCourseLesson, MarketplaceCourseSection } from './entities';

function buildService(
  course: MarketplaceCourse | null,
  sectionRows: MarketplaceCourseSection[],
  lessonRows: MarketplaceCourseLesson[],
) {
  const courses = {
    findOne: jest.fn(async ({ where }: { where: { id: string; instructor_id: string } }) =>
      course && course.id === where.id && course.instructor_id === where.instructor_id ? course : null,
    ),
  };
  const lessons = {
    save: jest.fn(async (entity: MarketplaceCourseLesson) => entity),
    createQueryBuilder: jest.fn(() => {
      let params: Record<string, unknown> = {};
      const qb = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn((_clause: string, p?: Record<string, unknown>) => {
          params = { ...params, ...p };
          return qb;
        }),
        andWhere: jest.fn((_clause: string, p?: Record<string, unknown>) => {
          params = { ...params, ...p };
          return qb;
        }),
        getOne: jest.fn(async () => {
          const courseSectionIds = sectionRows.filter((s) => s.course_id === params['courseId']).map((s) => s.id);
          return lessonRows.find((l) => l.id === params['lessonId'] && courseSectionIds.includes(l.section_id)) ?? null;
        }),
      };
      return qb;
    }),
  };
  const bunnyStream = {
    createVideo: jest.fn().mockResolvedValue({ videoId: 'bunny-video-1', libraryId: 'lib-1' }),
    createTusAuthorization: jest.fn().mockReturnValue({
      endpoint: 'https://video.bunnycdn.com/tusupload',
      headers: {},
      expiresAt: new Date(),
    }),
    getVideo: jest.fn().mockResolvedValue({ status: 'processing', progress: 40 }),
  } as unknown as jest.Mocked<BunnyStreamService>;

  const service = new LessonVideoService(courses as never, lessons as never, bunnyStream);
  return { service, courses, lessons, bunnyStream };
}

function buildCourse(overrides: Partial<MarketplaceCourse> = {}): MarketplaceCourse {
  return { id: 'course-1', instructor_id: 'instr-1', ...overrides } as unknown as MarketplaceCourse;
}
function buildSection(overrides: Partial<MarketplaceCourseSection> = {}): MarketplaceCourseSection {
  return { id: 'section-1', course_id: 'course-1', ...overrides } as unknown as MarketplaceCourseSection;
}
function buildLesson(overrides: Partial<MarketplaceCourseLesson> = {}): MarketplaceCourseLesson {
  return { id: 'lesson-1', section_id: 'section-1', title: 'Intro', video_id: null, ...overrides } as unknown as MarketplaceCourseLesson;
}

describe('LessonVideoService', () => {
  describe('createUploadAuthorization', () => {
    it('creates a Bunny video, stamps video_id on the lesson, and returns TUS credentials', async () => {
      const lesson = buildLesson();
      const { service, lessons, bunnyStream } = buildService(buildCourse(), [buildSection()], [lesson]);
      const result = await service.createUploadAuthorization('instr-1', 'course-1', 'lesson-1');

      expect(bunnyStream.createVideo).toHaveBeenCalledWith('Intro');
      expect(lesson.video_id).toBe('bunny-video-1');
      expect(lessons.save).toHaveBeenCalledWith(lesson);
      expect(result.videoId).toBe('bunny-video-1');
      expect(result.tusAuthorization.endpoint).toContain('bunnycdn.com');
    });

    it('refuses when the course belongs to a different instructor (no IDOR)', async () => {
      const { service } = buildService(buildCourse({ instructor_id: 'instr-1' }), [buildSection()], [buildLesson()]);
      await expect(service.createUploadAuthorization('instr-2', 'course-1', 'lesson-1')).rejects.toThrow();
    });

    it('refuses when the lesson belongs to a section in a different course', async () => {
      const otherSection = buildSection({ id: 'other-section', course_id: 'other-course' });
      const lesson = buildLesson({ section_id: 'other-section' });
      const { service } = buildService(buildCourse(), [otherSection], [lesson]);
      await expect(service.createUploadAuthorization('instr-1', 'course-1', 'lesson-1')).rejects.toThrow();
    });
  });

  describe('getVideoStatus', () => {
    it('reports the Bunny processing status for an uploaded lesson', async () => {
      const lesson = buildLesson({ video_id: 'bunny-video-1' });
      const { service, bunnyStream } = buildService(buildCourse(), [buildSection()], [lesson]);
      const result = await service.getVideoStatus('instr-1', 'course-1', 'lesson-1');
      expect(bunnyStream.getVideo).toHaveBeenCalledWith('bunny-video-1');
      expect(result.status).toBe('processing');
    });

    it('refuses when no video has been uploaded yet', async () => {
      const lesson = buildLesson({ video_id: null });
      const { service } = buildService(buildCourse(), [buildSection()], [lesson]);
      await expect(service.getVideoStatus('instr-1', 'course-1', 'lesson-1')).rejects.toThrow();
    });
  });
});
