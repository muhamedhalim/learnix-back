import { NotFoundException } from '@nestjs/common';

import { ParentMessageStatus } from '../entities';
import { ParentMessageAdminService, type StudentScope } from './parent-message-admin.service';

/**
 * T066: the optional student scope may be an id array (original form), an empty
 * array ("owns nothing"), or an owned-students subquery with its own named binds.
 */
describe('ParentMessageAdminService scope', () => {
  const subquery: StudentScope = {
    sql: 'SELECT "lp"."student_id" AS "student_id" FROM "lesson_purchases" "lp" WHERE "lesson"."teacher_id" = :ownerTeacherId',
    params: { ownerTeacherId: 'teacher-1' },
  };

  interface QueryBuilderMock {
    leftJoinAndSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    select: jest.Mock;
    addSelect: jest.Mock;
    groupBy: jest.Mock;
    getManyAndCount: jest.Mock;
    getRawMany: jest.Mock;
    getExists: jest.Mock;
  }

  let qb: QueryBuilderMock;
  let messages: { createQueryBuilder: jest.Mock; findOne: jest.Mock };
  let jobs: { enqueueRedelivery: jest.Mock };
  let service: ParentMessageAdminService;

  beforeEach(() => {
    qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      getRawMany: jest.fn().mockResolvedValue([]),
      getExists: jest.fn().mockResolvedValue(true),
    };
    messages = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      findOne: jest.fn(),
    };
    jobs = { enqueueRedelivery: jest.fn().mockResolvedValue(undefined) };
    service = new ParentMessageAdminService(
      messages as never,
      {} as never,
      {} as never,
      jobs as never,
    );
  });

  const scopeCalls = (mock: jest.Mock): unknown[][] =>
    mock.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('m.student_id IN ('));

  describe('list', () => {
    it('binds an id array as before', async () => {
      await service.list({}, ['s1', 's2']);

      expect(qb.andWhere).toHaveBeenCalledWith('m.student_id IN (:...scopeStudentIds)', {
        scopeStudentIds: ['s1', 's2'],
      });
    });

    it('returns an empty page for an empty array without touching the database', async () => {
      const result = await service.list({ page: 1, limit: 20 }, []);

      expect(result.data).toEqual([]);
      expect(result.meta.total).toBe(0);
      expect(messages.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('applies a subquery scope with its own bind and no id expansion', async () => {
      await service.list({}, subquery);

      const [call] = scopeCalls(qb.andWhere);
      expect(call).toEqual([
        `m.student_id IN (${(subquery as { sql: string }).sql})`,
        { ownerTeacherId: 'teacher-1' },
      ]);
      expect(JSON.stringify(qb.andWhere.mock.calls)).not.toContain(':...');
    });

    it('does not collide with the caller filters: scope and student_id keep separate bind names', async () => {
      await service.list(
        { student_id: 's9', status: ParentMessageStatus.FAILED, search: 'x' },
        subquery,
      );

      const binds = qb.andWhere.mock.calls.map(
        ([, params]) => params as Record<string, unknown> | undefined,
      );
      const names = binds.flatMap((params) => Object.keys(params ?? {}));
      expect(names).toEqual(expect.arrayContaining(['ownerTeacherId', 'studentId', 'status', 'q']));
      expect(new Set(names).size).toBe(names.length);
      expect(qb.andWhere).toHaveBeenCalledWith('m.student_id = :studentId', { studentId: 's9' });
    });

    it('adds no student restriction for admin callers (no scope)', async () => {
      await service.list({ student_id: 's9' });

      expect(scopeCalls(qb.andWhere)).toEqual([]);
      expect(qb.andWhere).toHaveBeenCalledWith('m.student_id = :studentId', { studentId: 's9' });
    });
  });

  describe('stats', () => {
    it('short-circuits an empty array to zero stats', async () => {
      await expect(service.stats([])).resolves.toEqual({
        total: 0,
        by_status: {},
        delivery_rate: 0,
        read_rate: 0,
      });
      expect(messages.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('uses the id array form with where()', async () => {
      await service.stats(['s1']);

      expect(qb.where).toHaveBeenCalledWith('m.student_id IN (:...scopeStudentIds)', {
        scopeStudentIds: ['s1'],
      });
    });

    it('uses the subquery form with where() and the same stats maths', async () => {
      qb.getRawMany.mockResolvedValue([
        { status: ParentMessageStatus.DELIVERED, count: '1' },
        { status: ParentMessageStatus.READ, count: '2' },
        { status: ParentMessageStatus.FAILED, count: '1' },
      ]);

      const result = await service.stats(subquery);

      expect(qb.where).toHaveBeenCalledWith(
        `m.student_id IN (${(subquery as { sql: string }).sql})`,
        { ownerTeacherId: 'teacher-1' },
      );
      expect(result).toEqual({
        total: 4,
        by_status: { delivered: 1, read: 2, failed: 1 },
        delivery_rate: 100,
        read_rate: 67,
      });
    });

    it('admin stats are unscoped', async () => {
      await service.stats();

      expect(qb.where).not.toHaveBeenCalled();
    });
  });

  describe('retry', () => {
    it('404s an unknown id before any scope check', async () => {
      messages.findOne.mockResolvedValue(null);

      await expect(service.retry('m1', subquery)).rejects.toBeInstanceOf(NotFoundException);
      expect(qb.getExists).not.toHaveBeenCalled();
    });

    it('404s a message outside an array scope', async () => {
      messages.findOne.mockResolvedValue({
        id: 'm1',
        student_id: 's9',
        status: ParentMessageStatus.FAILED,
      });

      await expect(service.retry('m1', ['s1'])).rejects.toBeInstanceOf(NotFoundException);
      expect(jobs.enqueueRedelivery).not.toHaveBeenCalled();
    });

    it('runs one EXISTS for a subquery scope and 404s with the same body when outside it', async () => {
      messages.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'm1', student_id: 's9', status: ParentMessageStatus.FAILED });
      qb.getExists.mockResolvedValue(false);

      const missing = await service.retry('m-missing', subquery).catch((error: unknown) => error);
      const foreign = await service.retry('m1', subquery).catch((error: unknown) => error);

      expect(foreign).toBeInstanceOf(NotFoundException);
      expect((foreign as NotFoundException).getResponse()).toEqual(
        (missing as NotFoundException).getResponse(),
      );
      expect(qb.getExists).toHaveBeenCalledTimes(1);
      expect(jobs.enqueueRedelivery).not.toHaveBeenCalled();
    });

    it('re-enqueues a failed message that is inside a subquery scope', async () => {
      messages.findOne.mockResolvedValue({
        id: 'm1',
        student_id: 's1',
        status: ParentMessageStatus.FAILED,
      });
      qb.getExists.mockResolvedValue(true);

      await expect(service.retry('m1', subquery)).resolves.toEqual({ queued: true });
      expect(qb.where).toHaveBeenCalledWith('m.id = :scopedMessageId', { scopedMessageId: 'm1' });
      expect(jobs.enqueueRedelivery).toHaveBeenCalledWith('m1');
    });

    it('admin retry skips the scope check entirely', async () => {
      messages.findOne.mockResolvedValue({
        id: 'm1',
        student_id: 's1',
        status: ParentMessageStatus.FAILED,
      });

      await expect(service.retry('m1')).resolves.toEqual({ queued: true });
      expect(messages.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('does not re-send a message the guardian already received', async () => {
      messages.findOne.mockResolvedValue({
        id: 'm1',
        student_id: 's1',
        status: ParentMessageStatus.READ,
      });

      await expect(service.retry('m1', ['s1'])).resolves.toEqual({ queued: false });
      expect(jobs.enqueueRedelivery).not.toHaveBeenCalled();
    });
  });
});
