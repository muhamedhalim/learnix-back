import { LessonVideoService } from './lesson-video.service';
import type {
  MarketplaceCourse,
  MarketplaceCourseLesson,
  MarketplaceCourseSection,
} from './entities';

function buildService(
  course: MarketplaceCourse | null,
  sectionRows: MarketplaceCourseSection[],
  lessonRows: MarketplaceCourseLesson[],
) {
  const courses = {
    findOne: jest.fn(async ({ where }: { where: { id: string; instructor_id: string } }) =>
      course && course.id === where.id && course.instructor_id === where.instructor_id
        ? course
        : null,
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
          const courseSectionIds = sectionRows
            .filter((s) => s.course_id === params['courseId'])
            .map((s) => s.id);
          return (
            lessonRows.find(
              (l) => l.id === params['lessonId'] && courseSectionIds.includes(l.section_id),
            ) ?? null
          );
        }),
      };
      return qb;
    }),
  };
  const awsVideo = {
    isEnabled: jest.fn().mockReturnValue(true),
    getStatus: jest.fn().mockResolvedValue({
      status: 'processing',
      duration_seconds: null,
      width: null,
      height: null,
      size_bytes: null,
    }),
  };
  const directUploads = { init: jest.fn().mockResolvedValue({ upload_id: 'upload-1' }) };

  const service = new LessonVideoService(
    courses as never,
    lessons as never,
    awsVideo as never,
    directUploads as never,
  );
  return { service, courses, lessons, awsVideo, directUploads };
}

function buildCourse(overrides: Partial<MarketplaceCourse> = {}): MarketplaceCourse {
  return { id: 'course-1', instructor_id: 'instr-1', ...overrides } as unknown as MarketplaceCourse;
}
function buildSection(overrides: Partial<MarketplaceCourseSection> = {}): MarketplaceCourseSection {
  return {
    id: 'section-1',
    course_id: 'course-1',
    ...overrides,
  } as unknown as MarketplaceCourseSection;
}
function buildLesson(overrides: Partial<MarketplaceCourseLesson> = {}): MarketplaceCourseLesson {
  return {
    id: 'lesson-1',
    section_id: 'section-1',
    title: 'Intro',
    video_id: null,
    ...overrides,
  } as unknown as MarketplaceCourseLesson;
}

const UPLOAD = { filename: 'intro.mp4', contentType: 'video/mp4', size: 1024 };

describe('LessonVideoService', () => {
  describe('startAwsUpload', () => {
    it('starts a direct upload for the signed-in user', async () => {
      const { service, directUploads } = buildService(
        buildCourse(),
        [buildSection()],
        [buildLesson()],
      );
      await service.startAwsUpload('instr-1', 'user-1', 'course-1', 'lesson-1', UPLOAD);

      expect(directUploads.init).toHaveBeenCalledWith('user-1', {
        purpose: 'lesson_video',
        ...UPLOAD,
      });
    });

    it('refuses to start or complete an upload while the course is under review (FR-063)', async () => {
      const { service, directUploads } = buildService(
        buildCourse({ status: 'submitted_for_review' } as never),
        [buildSection()],
        [buildLesson()],
      );
      const expected = { response: expect.objectContaining({ code: 'COURSE_NOT_EDITABLE_UNDER_REVIEW' }) };
      await expect(
        service.startAwsUpload('instr-1', 'user-1', 'course-1', 'lesson-1', UPLOAD),
      ).rejects.toMatchObject(expected);
      await expect(
        service.completeAwsUpload('instr-1', 'user-1', 'course-1', 'lesson-1', 'upload-1'),
      ).rejects.toMatchObject(expected);
      expect(directUploads.init).not.toHaveBeenCalled();
    });

    it('still lets the owner poll the status of a video while the course is under review', async () => {
      const { service } = buildService(
        buildCourse({ status: 'submitted_for_review' } as never),
        [buildSection()],
        [buildLesson({ video_id: 'aws:asset-1' } as never)],
      );
      await expect(service.getVideoStatus('instr-1', 'course-1', 'lesson-1')).resolves.toBeDefined();
    });

    it('refuses when the course belongs to a different instructor (no IDOR)', async () => {
      const { service, directUploads } = buildService(
        buildCourse({ instructor_id: 'instr-1' }),
        [buildSection()],
        [buildLesson()],
      );
      await expect(
        service.startAwsUpload('instr-2', 'user-2', 'course-1', 'lesson-1', UPLOAD),
      ).rejects.toThrow();
      expect(directUploads.init).not.toHaveBeenCalled();
    });

    it('refuses when the lesson belongs to a section in a different course', async () => {
      const otherSection = buildSection({ id: 'other-section', course_id: 'other-course' });
      const lesson = buildLesson({ section_id: 'other-section' });
      const { service } = buildService(buildCourse(), [otherSection], [lesson]);
      await expect(
        service.startAwsUpload('instr-1', 'user-1', 'course-1', 'lesson-1', UPLOAD),
      ).rejects.toThrow();
    });

    it('refuses when the AWS video pipeline is not enabled on this deployment', async () => {
      const { service, awsVideo, directUploads } = buildService(
        buildCourse(),
        [buildSection()],
        [buildLesson()],
      );
      awsVideo.isEnabled.mockReturnValue(false);
      await expect(
        service.startAwsUpload('instr-1', 'user-1', 'course-1', 'lesson-1', UPLOAD),
      ).rejects.toThrow();
      expect(directUploads.init).not.toHaveBeenCalled();
    });
  });

  describe('getVideoStatus', () => {
    it('reports the processing status of an uploaded AWS video', async () => {
      const lesson = buildLesson({ video_id: 'aws:asset-1' });
      const { service, awsVideo } = buildService(buildCourse(), [buildSection()], [lesson]);
      const result = await service.getVideoStatus('instr-1', 'course-1', 'lesson-1');
      expect(awsVideo.getStatus).toHaveBeenCalledWith('asset-1');
      expect(result.status).toBe('processing');
    });

    it('refuses when no video has been uploaded yet', async () => {
      const lesson = buildLesson({ video_id: null });
      const { service } = buildService(buildCourse(), [buildSection()], [lesson]);
      await expect(service.getVideoStatus('instr-1', 'course-1', 'lesson-1')).rejects.toThrow();
    });

    it('treats a reference that is not an AWS asset as no video', async () => {
      const lesson = buildLesson({ video_id: 'f3a8-legacy-provider-guid' });
      const { service, awsVideo } = buildService(buildCourse(), [buildSection()], [lesson]);
      await expect(service.getVideoStatus('instr-1', 'course-1', 'lesson-1')).rejects.toThrow();
      expect(awsVideo.getStatus).not.toHaveBeenCalled();
    });
  });
});
