import { NotFoundException } from '@nestjs/common';

import { InstructorAdminService } from './instructor-admin.service';

function buildInstructor(overrides: Record<string, unknown> = {}) {
  return { id: 'instructor-1', application_id: 'app-1', ...overrides };
}

describe('InstructorAdminService (T192, FR-283)', () => {
  let instructors: { findAndCount: jest.Mock; findOne: jest.Mock };
  let applications: { findOne: jest.Mock };
  let courses: { count: jest.Mock; find: jest.Mock };
  let enrollments: { count: jest.Mock };
  let earnings: { createQueryBuilder: jest.Mock };
  let payoutRequests: { find: jest.Mock };
  let balance: { getAllBalances: jest.Mock };
  let ledger: { listEntriesAdmin: jest.Mock };
  let service: InstructorAdminService;

  beforeEach(() => {
    instructors = { findAndCount: jest.fn().mockResolvedValue([[], 0]), findOne: jest.fn() };
    applications = { findOne: jest.fn() };
    courses = { count: jest.fn().mockResolvedValue(0), find: jest.fn().mockResolvedValue([]) };
    enrollments = { count: jest.fn().mockResolvedValue(0) };
    earnings = {
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      }),
    };
    payoutRequests = { find: jest.fn().mockResolvedValue([]) };
    balance = { getAllBalances: jest.fn().mockResolvedValue([]) };
    ledger = { listEntriesAdmin: jest.fn().mockResolvedValue({ data: [], meta: {} }) };
    service = new InstructorAdminService(
      instructors as never,
      applications as never,
      courses as never,
      enrollments as never,
      earnings as never,
      payoutRequests as never,
      balance as never,
      ledger as never,
    );
  });

  describe('listRoster', () => {
    it('batches the financial summary in one query for the whole page — never one query per row', async () => {
      instructors.findAndCount.mockResolvedValue([[buildInstructor(), buildInstructor({ id: 'instructor-2' })], 2]);
      const rawResults = [{ instructor_id: 'instructor-1', currency: 'EGP', total: '7000' }];
      earnings.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rawResults),
      });

      const result = await service.listRoster();

      expect(earnings.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(result.data).toHaveLength(2);
      expect(result.data[0]!.totalEarnedMinor).toEqual([{ currency: 'EGP', totalMinor: 7000 }]);
      expect(result.data[1]!.totalEarnedMinor).toEqual([]);
    });

    it('skips the earnings query entirely when the page is empty', async () => {
      instructors.findAndCount.mockResolvedValue([[], 0]);
      await service.listRoster();
      expect(earnings.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('getFullRecord', () => {
    it('404s an instructor that does not exist', async () => {
      instructors.findOne.mockResolvedValue(null);
      await expect(service.getFullRecord('missing')).rejects.toThrow(NotFoundException);
    });

    it('assembles application, courses, learners, balances, ledger and payouts together', async () => {
      instructors.findOne.mockResolvedValue(buildInstructor());
      applications.findOne.mockResolvedValue({ id: 'app-1' });
      courses.count.mockResolvedValue(3);
      courses.find.mockResolvedValue([{ id: 'course-1' }, { id: 'course-2' }]);
      enrollments.count.mockResolvedValue(42);
      balance.getAllBalances.mockResolvedValue([{ currency: 'EGP', availableMinor: 1000 }]);
      payoutRequests.find.mockResolvedValue([{ id: 'payout-1' }]);

      const record = await service.getFullRecord('instructor-1');

      expect(record.courseCount).toBe(3);
      expect(record.learnerCount).toBe(42);
      expect(record.balances).toHaveLength(1);
      expect(record.payoutRequests).toHaveLength(1);
      expect(ledger.listEntriesAdmin).toHaveBeenCalledWith(expect.objectContaining({ instructorId: 'instructor-1' }));
    });

    it('never counts learners when the instructor has no courses at all', async () => {
      instructors.findOne.mockResolvedValue(buildInstructor());
      courses.find.mockResolvedValue([]);

      const record = await service.getFullRecord('instructor-1');

      expect(record.learnerCount).toBe(0);
      expect(enrollments.count).not.toHaveBeenCalled();
    });
  });
});
