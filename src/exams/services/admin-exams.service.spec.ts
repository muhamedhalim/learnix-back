import { ExamStatus } from '../entities';
import { AdminExamsService } from './admin-exams.service';

/** Records every where-clause so list and count predicates can be compared. */
function fakeBuilder(result: { many?: unknown[]; raw?: unknown[] }) {
  const wheres: string[] = [];
  const params: Array<Record<string, unknown> | undefined> = [];
  const builder: Record<string, jest.Mock> = {};
  for (const method of [
    'leftJoinAndSelect',
    'select',
    'addSelect',
    'groupBy',
    'orderBy',
    'skip',
    'take',
  ]) {
    builder[method] = jest.fn().mockReturnValue(builder);
  }
  const record = (clause: string, p?: Record<string, unknown>) => {
    wheres.push(clause);
    params.push(p);
    return builder;
  };
  builder['where'] = jest.fn(record);
  builder['andWhere'] = jest.fn(record);
  builder['getManyAndCount'] = jest.fn().mockResolvedValue([result.many ?? [], result.many?.length ?? 0]);
  builder['getRawMany'] = jest.fn().mockResolvedValue(result.raw ?? []);
  return { builder, wheres, params };
}

describe('AdminExamsService.list status counts (T053)', () => {
  function setup(statusRows: Array<{ status: string; count: string }>) {
    const page = fakeBuilder({ many: [] });
    const count = fakeBuilder({ raw: statusRows });
    const exams = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(page.builder)
        .mockReturnValueOnce(count.builder),
    };
    const service = new AdminExamsService(exams as never, {} as never, {} as never);
    return { service, page, count, exams };
  }

  it('without the flag: no extra statement and an unchanged meta', async () => {
    const { service, exams } = setup([]);
    const result = await service.list({ status: ExamStatus.DRAFT });
    expect(exams.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(result.meta).not.toHaveProperty('status_counts');
  });

  it('with the flag: one grouped statement, zero-filled, status filter excluded', async () => {
    const { service, page, count } = setup([{ status: 'published', count: '3' }]);
    const filter = {
      include_status_counts: true,
      status: ExamStatus.DRAFT,
      subject_id: 's1',
      teacher_id: 't1',
      search: 'alg',
      date_from: '2026-01-01',
      date_to: '2026-02-01',
    };
    const result = await service.list(filter);

    expect(result.meta.status_counts).toEqual({
      draft: 0,
      published: 3,
      scheduled: 0,
      archived: 0,
    });
    // The count applies every predicate the page applies, except status.
    const pageWheres = page.wheres.filter((w) => !w.includes('exam.status'));
    expect(count.wheres).toEqual(pageWheres);
    expect(page.wheres.some((w) => w.includes('exam.status'))).toBe(true);
    expect(count.wheres.some((w) => w.includes('exam.status ='))).toBe(false);
    expect(count.builder['groupBy']).toHaveBeenCalledWith('exam.status');
    expect(count.wheres).toContain('exam.deleted_at IS NULL');
  });
});
