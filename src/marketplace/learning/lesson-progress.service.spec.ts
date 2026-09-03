import { LessonProgressService } from './lesson-progress.service';

const ENROLLMENT = { id: 'enrollment-1', learner_id: 'learner-1', course_id: 'course-1' };

function buildLessonQueryBuilder(found: boolean) {
  return {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(found ? { id: 'lesson-1' } : null),
  };
}

function buildService(opts: {
  lessonInCourse?: boolean;
  existingRow?: Record<string, unknown> | null;
} = {}) {
  const lessonInCourse = opts.lessonInCourse ?? true;
  const existingRow = 'existingRow' in opts ? opts.existingRow : null;

  const access = { verifyAccess: jest.fn().mockResolvedValue(ENROLLMENT) };
  const lessons = { createQueryBuilder: jest.fn(() => buildLessonQueryBuilder(lessonInCourse)) };

  const store = new Map<string, Record<string, unknown>>();
  if (existingRow) store.set('enrollment-1:lesson-1', existingRow);

  const repoFactory = () => ({
    findOne: jest.fn(async ({ where }: { where: { enrollment_id: string; lesson_id: string } }) =>
      store.get(`${where.enrollment_id}:${where.lesson_id}`) ?? null,
    ),
    create: jest.fn((data: Record<string, unknown>) => ({ enrollment_id: 'enrollment-1', lesson_id: 'lesson-1', is_completed: false, completed_at: null, last_position_seconds: 0, ...data })),
    save: jest.fn(async (data: Record<string, unknown>) => {
      const key = `${data['enrollment_id']}:${data['lesson_id']}`;
      const saved = { id: 'progress-1', ...data };
      store.set(key, saved);
      return saved;
    }),
    find: jest.fn(async () => [...store.values()]),
  });
  const progressRepo = repoFactory();
  const manager = { getRepository: jest.fn(() => progressRepo) };
  const dataSource = { transaction: jest.fn((fn: (m: unknown) => unknown) => fn(manager)) };

  const progressService = { recompute: jest.fn().mockResolvedValue({ progressBps: 5000, completedRequired: 1, totalRequired: 2 }) };
  const completion = { checkCompletion: jest.fn().mockResolvedValue(false) };

  const service = new LessonProgressService(
    progressRepo as never,
    lessons as never,
    access as never,
    progressService as never,
    completion as never,
    dataSource as never,
  );
  return { service, access, lessons, progressRepo, progressService, completion, store };
}

describe('LessonProgressService (T122)', () => {
  it('marks a lesson complete, recomputes progress, and checks completion (FR-238)', async () => {
    const { service, progressService, completion, store } = buildService();
    const row = await service.markComplete('learner-1', 'course-1', 'lesson-1');

    expect(row).toMatchObject({ is_completed: true });
    expect(store.get('enrollment-1:lesson-1')).toMatchObject({ is_completed: true });
    expect(progressService.recompute).toHaveBeenCalledWith('enrollment-1', expect.anything());
    expect(completion.checkCompletion).toHaveBeenCalledWith('enrollment-1', 5000, expect.anything());
  });

  it('is idempotent: marking an already-complete lesson again does not recompute or re-check completion', async () => {
    const completedAt = new Date('2026-01-01');
    const { service, progressService, completion } = buildService({
      existingRow: { enrollment_id: 'enrollment-1', lesson_id: 'lesson-1', is_completed: true, completed_at: completedAt },
    });

    const row = await service.markComplete('learner-1', 'course-1', 'lesson-1');

    expect(row).toMatchObject({ is_completed: true, completed_at: completedAt });
    expect(progressService.recompute).not.toHaveBeenCalled();
    expect(completion.checkCompletion).not.toHaveBeenCalled();
  });

  it('reverses a completion (unmark) and recomputes, but never checks completion', async () => {
    const { service, progressService, completion, store } = buildService({
      existingRow: { enrollment_id: 'enrollment-1', lesson_id: 'lesson-1', is_completed: true, completed_at: new Date() },
    });

    const row = await service.markIncomplete('learner-1', 'course-1', 'lesson-1');

    expect(row).toMatchObject({ is_completed: false, completed_at: null });
    expect(store.get('enrollment-1:lesson-1')).toMatchObject({ is_completed: false });
    expect(progressService.recompute).toHaveBeenCalled();
    expect(completion.checkCompletion).not.toHaveBeenCalled();
  });

  it('unmarking an already-incomplete (or never-marked) lesson is a no-op that does not recompute', async () => {
    const { service, progressService } = buildService();
    const row = await service.markIncomplete('learner-1', 'course-1', 'lesson-1');

    expect(row).toMatchObject({ is_completed: false });
    expect(progressService.recompute).not.toHaveBeenCalled();
  });

  it('refuses a lesson that does not belong to the course (IDOR-shaped input)', async () => {
    const { service } = buildService({ lessonInCourse: false });
    await expect(service.markComplete('learner-1', 'course-1', 'lesson-from-another-course')).rejects.toThrow();
  });

  it('refuses when the learner has no active enrollment — propagates AccessService.verifyAccess', async () => {
    const { service, access } = buildService();
    access.verifyAccess.mockRejectedValue(new Error('no access'));
    await expect(service.markComplete('learner-1', 'course-1', 'lesson-1')).rejects.toThrow('no access');
  });

  it('records and restores last position without touching progress or completion (FR-239)', async () => {
    const { service, progressService } = buildService();
    const row = await service.updatePosition('learner-1', 'course-1', 'lesson-1', 125);

    expect(row).toMatchObject({ last_position_seconds: 125 });
    expect(progressService.recompute).not.toHaveBeenCalled();
  });

  it('never accepts a negative position', async () => {
    const { service } = buildService();
    const row = await service.updatePosition('learner-1', 'course-1', 'lesson-1', -50);
    expect(row).toMatchObject({ last_position_seconds: 0 });
  });
});
