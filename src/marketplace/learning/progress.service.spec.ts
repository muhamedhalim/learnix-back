import { ProgressService } from './progress.service';

function buildQueryBuilder(totalRequired: number, completedRequired: number) {
  let isCompletedQuery = false;
  const qb = {
    innerJoin: jest.fn((entityOrTable: unknown) => {
      if (entityOrTable === 'marketplace_lesson_progress') isCompletedQuery = true;
      return qb;
    }),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(async () =>
      isCompletedQuery ? { completed: String(completedRequired) } : { total: String(totalRequired) },
    ),
  };
  return qb;
}

function buildService(opts: {
  enrollment?: Record<string, unknown> | null;
  totalRequired?: number;
  completedRequired?: number;
}) {
  const enrollment = 'enrollment' in opts ? opts.enrollment : { id: 'enrollment-1', course_id: 'course-1' };
  const enrollments = {
    findOneOrFail: jest.fn(async () => {
      if (!enrollment) throw new Error('enrollment not found');
      return enrollment;
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const lessons = {
    createQueryBuilder: jest.fn(() => buildQueryBuilder(opts.totalRequired ?? 0, opts.completedRequired ?? 0)),
  };
  const service = new ProgressService(enrollments as never, lessons as never);
  return { service, enrollments, lessons };
}

describe('ProgressService (T120, T121, T124)', () => {
  it('computes floor(completed_required * 10000 / total_required) (FR-240)', async () => {
    const { service, enrollments } = buildService({ totalRequired: 3, completedRequired: 1 });
    const result = await service.recompute('enrollment-1');

    expect(result).toEqual({ progressBps: 3333, completedRequired: 1, totalRequired: 3 });
    expect(enrollments.update).toHaveBeenCalledWith({ id: 'enrollment-1' }, { progress_bps: 3333 });
  });

  it('reaches exactly 10000 when every required lesson is complete', async () => {
    const { service } = buildService({ totalRequired: 5, completedRequired: 5 });
    await expect(service.recompute('enrollment-1')).resolves.toMatchObject({ progressBps: 10000 });
  });

  it('a course with zero required lessons always recomputes to 0, never divides by zero (FR-333)', async () => {
    const { service } = buildService({ totalRequired: 0, completedRequired: 0 });
    await expect(service.recompute('enrollment-1')).resolves.toMatchObject({ progressBps: 0, totalRequired: 0 });
  });

  it('floors rather than rounds — a non-terminating fraction never reaches the next lesson early', async () => {
    const { service } = buildService({ totalRequired: 7, completedRequired: 1 });
    // 1/7 = 0.142857... * 10000 = 1428.57 -> floors to 1428, not 1429
    await expect(service.recompute('enrollment-1')).resolves.toMatchObject({ progressBps: 1428 });
  });

  it('re-running recompute after marking the same lesson complete again is idempotent (no double count possible — the query counts distinct completed lessons, not completion events)', async () => {
    const { service } = buildService({ totalRequired: 4, completedRequired: 2 });
    const first = await service.recompute('enrollment-1');
    const second = await service.recompute('enrollment-1');
    expect(first).toEqual(second);
  });

  it('reflects a smaller required-lesson total after a curriculum change (T124, FR-243) — no special-case code needed since the total is always queried live', async () => {
    // Before: 4 required lessons, 2 complete -> 5000 bps. After a lesson is
    // deleted (or turned optional): 3 required lessons, the same 2 still
    // complete (their progress rows are untouched by this service) -> 6666.
    const before = buildService({ totalRequired: 4, completedRequired: 2 });
    await expect(before.service.recompute('enrollment-1')).resolves.toMatchObject({ progressBps: 5000 });

    const after = buildService({ totalRequired: 3, completedRequired: 2 });
    await expect(after.service.recompute('enrollment-1')).resolves.toMatchObject({ progressBps: 6666 });
  });

  it('queries against the live course_id (course_id from the enrollment), not a version snapshot', async () => {
    const { service, lessons } = buildService({
      enrollment: { id: 'enrollment-1', course_id: 'course-42' },
      totalRequired: 1,
      completedRequired: 0,
    });
    await service.recompute('enrollment-1');
    const [firstCall] = lessons.createQueryBuilder.mock.results;
    const qb = firstCall!.value as { where: jest.Mock };
    expect(qb.where).toHaveBeenCalledWith('s.course_id = :courseId', { courseId: 'course-42' });
  });

  it('rejects for a nonexistent enrollment', async () => {
    const { service } = buildService({ enrollment: null });
    await expect(service.recompute('missing')).rejects.toThrow();
  });
});
