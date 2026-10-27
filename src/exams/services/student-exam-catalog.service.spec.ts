import { StudentExamCatalogService } from './student-exam-catalog.service';

function buildService(rows: unknown[], total: number) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'leftJoinAndSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
  ]) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([rows, total]);
  const exams = { createQueryBuilder: jest.fn(() => qb) };
  const access = { applyStudentScope: jest.fn() };
  const service = new StudentExamCatalogService(exams as never, access as never);
  return { service, qb, access };
}

const exam = {
  id: 'e1',
  title: 'Midterm',
  title_ar: 'منتصف',
  description: 'd',
  description_ar: 'و',
  subject: { id: 's1', name: 'Math', extra: 'dropped' },
  teacher: { id: 't1', name: 'Ms Rana', email: 'private@example.com' },
  total_marks: 50,
  passing_marks: 25,
  config: { duration_seconds: 1800, attempts_allowed: 2 },
  status: 'published',
  is_public: false,
};

describe('StudentExamCatalogService', () => {
  it('lists only the student-scoped exams and projects the public list shape', async () => {
    const { service, access, qb } = buildService([exam], 1);

    const result = await service.listForStudent('student-1', { page: 1, limit: 20 } as never);

    expect(access.applyStudentScope).toHaveBeenCalledWith(qb, 'student-1');
    expect(result).toEqual({
      data: [
        {
          id: 'e1',
          title: 'Midterm',
          title_ar: 'منتصف',
          description: 'd',
          description_ar: 'و',
          subject: { id: 's1', name: 'Math' },
          teacher: { id: 't1', name: 'Ms Rana' },
          total_marks: 50,
          passing_marks: 25,
          duration_seconds: 1800,
          attempts_allowed: 2,
          start_window_at: null,
          end_window_at: null,
          status: 'published',
          is_public: false,
        },
      ],
      meta: { total: 1, page: 1, limit: 20, totalPages: 1, hasNextPage: false, hasPrevPage: false },
    });
  });

  it('applies subject and search filters and paginates', async () => {
    const { service, qb } = buildService([], 45);

    const result = (await service.listForStudent('student-1', {
      page: 2,
      limit: 20,
      subject_id: 'subject-9',
      search: 'alg',
    } as never)) as { meta: unknown };

    expect(qb.andWhere).toHaveBeenCalledWith('exam.subject_id = :s', { s: 'subject-9' });
    expect(qb.andWhere).toHaveBeenCalledWith('(exam.title ILIKE :q OR exam.title_ar ILIKE :q)', {
      q: '%alg%',
    });
    expect(qb.skip).toHaveBeenCalledWith(20);
    expect(qb.take).toHaveBeenCalledWith(20);
    expect(result.meta).toEqual({
      total: 45,
      page: 2,
      limit: 20,
      totalPages: 3,
      hasNextPage: true,
      hasPrevPage: true,
    });
  });

  it('the question bank is public-only and never applies the student scope', async () => {
    const { service, qb, access } = buildService([exam], 1);

    await service.listQuestionBank({ page: 1, limit: 20 } as never);

    expect(qb.andWhere).toHaveBeenCalledWith('exam.is_public = true');
    expect(access.applyStudentScope).not.toHaveBeenCalled();
  });
});
