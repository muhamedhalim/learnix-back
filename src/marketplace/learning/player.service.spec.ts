import { LessonContentType } from '../common/enums';
import { PlayerService } from './player.service';

const ENROLLMENT = { id: 'enrollment-1', course_id: 'course-1', progress_bps: 5000, completed_at: null };

function buildLessonQueryBuilder(lesson: Record<string, unknown> | null) {
  return {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(lesson),
  };
}

function buildService(opts: {
  enrollment?: Record<string, unknown> | Error;
  sections?: Record<string, unknown>[];
  lessons?: Record<string, unknown>[];
  progress?: Record<string, unknown>[];
  lessonLookup?: Record<string, unknown> | null;
  bunnySignedUrl?: string | null;
} = {}) {
  const enrollment = 'enrollment' in opts ? opts.enrollment : ENROLLMENT;
  const access = {
    verifyAccessByEnrollment: jest.fn(async () => {
      if (enrollment instanceof Error) throw enrollment;
      return enrollment;
    }),
  };
  const sections = { find: jest.fn().mockResolvedValue(opts.sections ?? []) };
  const lessons = {
    find: jest.fn().mockResolvedValue(opts.lessons ?? []),
    createQueryBuilder: jest.fn(() => buildLessonQueryBuilder('lessonLookup' in opts ? opts.lessonLookup! : null)),
  };
  const progress = { find: jest.fn().mockResolvedValue(opts.progress ?? []) };
  const bunnyStream = {
    generateSignedEmbedUrl: jest.fn().mockReturnValue(
      'bunnySignedUrl' in opts ? opts.bunnySignedUrl : 'https://signed.example/video',
    ),
  };

  const service = new PlayerService(sections as never, lessons as never, progress as never, access as never, bunnyStream as never);
  return { service, access, sections, lessons, progress, bunnyStream };
}

describe('PlayerService (T125)', () => {
  describe('getPlayerData', () => {
    it('returns sections with lessons decorated by progress, gated by enrollment access', async () => {
      const { service, access } = buildService({
        sections: [{ id: 's1', title: 'Intro', title_ar: null, position: 0 }],
        lessons: [
          { id: 'l1', section_id: 's1', title: 'L1', title_ar: null, position: 0, content_type: LessonContentType.TEXT, duration_seconds: 60, is_free_preview: true, is_required_for_completion: false },
          { id: 'l2', section_id: 's1', title: 'L2', title_ar: null, position: 1, content_type: LessonContentType.VIDEO, duration_seconds: 300, is_free_preview: false, is_required_for_completion: true },
        ],
        progress: [{ lesson_id: 'l2', is_completed: true, last_position_seconds: 42 }],
      });

      const data = await service.getPlayerData('learner-1', 'enrollment-1');

      expect(access.verifyAccessByEnrollment).toHaveBeenCalledWith('learner-1', 'enrollment-1');
      expect(data.enrollment_id).toBe('enrollment-1');
      expect(data.progress_bps).toBe(5000);
      expect(data.sections).toHaveLength(1);
      expect(data.sections[0]!.lessons).toEqual([
        expect.objectContaining({ id: 'l1', is_completed: false, last_position_seconds: 0 }),
        expect.objectContaining({ id: 'l2', is_completed: true, last_position_seconds: 42 }),
      ]);
    });

    it('loads lesson rows without their bodies: the curriculum map selects only the columns it returns (T083)', async () => {
      const { service, lessons } = buildService({
        sections: [{ id: 's1', title: 'Intro', title_ar: null, position: 0 }],
        lessons: [],
      });

      await service.getPlayerData('learner-1', 'enrollment-1');

      const options = lessons.find.mock.calls[0]![0] as { select: string[] };
      expect([...options.select].sort()).toEqual(
        [
          'content_type',
          'duration_seconds',
          'id',
          'is_free_preview',
          'is_required_for_completion',
          'position',
          'section_id',
          'title',
          'title_ar',
        ].sort(),
      );
      expect(options.select).not.toContain('content_html');
      expect(options.select).not.toContain('video_id');
    });

    it('propagates a lost-access refusal from AccessService rather than serving anything', async () => {
      const { service } = buildService({ enrollment: new Error('no access') });
      await expect(service.getPlayerData('learner-1', 'enrollment-1')).rejects.toThrow('no access');
    });

    it('handles a course with no sections at all without error', async () => {
      const { service } = buildService({ sections: [] });
      const data = await service.getPlayerData('learner-1', 'enrollment-1');
      expect(data.sections).toEqual([]);
    });
  });

  describe('getLessonContent', () => {
    it('signs a fresh, short-lived URL for a video lesson — never returns a durable address (FR-244)', async () => {
      const { service, bunnyStream } = buildService({
        lessonLookup: { id: 'l1', content_type: LessonContentType.VIDEO, video_id: 'bunny-video-1', content_html: null },
      });

      const content = await service.getLessonContent('learner-1', 'enrollment-1', 'l1');

      expect(bunnyStream.generateSignedEmbedUrl).toHaveBeenCalledWith('bunny-video-1', 300);
      expect(content).toMatchObject({ content_type: LessonContentType.VIDEO, playback_url: 'https://signed.example/video', expires_in: 300 });
    });

    it('returns content_html directly for a text lesson, no signing involved', async () => {
      const { service, bunnyStream } = buildService({
        lessonLookup: { id: 'l1', content_type: LessonContentType.TEXT, video_id: null, content_html: '<p>Hi</p>' },
      });

      const content = await service.getLessonContent('learner-1', 'enrollment-1', 'l1');

      expect(bunnyStream.generateSignedEmbedUrl).not.toHaveBeenCalled();
      expect(content).toMatchObject({ content_type: LessonContentType.TEXT, content_html: '<p>Hi</p>', playback_url: null });
    });

    it('404s for a lesson that does not belong to the enrolled course (IDOR-shaped input)', async () => {
      const { service } = buildService({ lessonLookup: null });
      await expect(service.getLessonContent('learner-1', 'enrollment-1', 'lesson-from-elsewhere')).rejects.toThrow();
    });

    it('404s a video lesson whose video has not finished uploading yet', async () => {
      const { service } = buildService({
        lessonLookup: { id: 'l1', content_type: LessonContentType.VIDEO, video_id: null, content_html: null },
      });
      await expect(service.getLessonContent('learner-1', 'enrollment-1', 'l1')).rejects.toThrow();
    });

    it('fails closed (503) rather than leaking an unsigned URL when Bunny signing is not configured', async () => {
      const { service } = buildService({
        lessonLookup: { id: 'l1', content_type: LessonContentType.VIDEO, video_id: 'bunny-video-1', content_html: null },
        bunnySignedUrl: null,
      });
      await expect(service.getLessonContent('learner-1', 'enrollment-1', 'l1')).rejects.toThrow();
    });
  });
});
