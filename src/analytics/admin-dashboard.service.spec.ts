import type { DataSource, Repository } from 'typeorm';

import { AdminDashboardService } from './admin-dashboard.service';

describe('AdminDashboardService', () => {
  it('scopes cache by principal and withholds finance-protected values without permissions', async () => {
    const userBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({ id: 'admin-1', finance_permissions: [] }),
    };
    const users = { createQueryBuilder: jest.fn().mockReturnValue(userBuilder) };
    const dataSource = {
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('FROM complaints')) {
          return [{ overdue_support_tickets: '2', unassigned_open_support_tickets: '1' }];
        }
        if (sql.includes('manual_payments_awaiting_review')) {
          return [
            {
              manual_payments_awaiting_review: null,
              draft_settlements_awaiting_approval: null,
              approved_settlements_awaiting_payment: null,
            },
          ];
        }
        return [
          {
            student_accounts: '10',
            teacher_accounts: '4',
            pending_students: '1',
            pending_teachers: '2',
            pending_subjects: '3',
            new_accounts: '5',
            active_learners: '6',
            lessons: '7',
            packages: '8',
            exams: '9',
            books: '10',
            lesson_views: '11',
            exam_attempts: '12',
            average_session_duration_seconds: '120',
            lesson_completion_rate: '75.5',
          },
        ];
      }),
    };
    const cache = {
      getOrCompute: jest
        .fn()
        .mockImplementation(
          async (_descriptor: unknown, compute: () => Promise<unknown>) => await compute(),
        ),
    };
    const payments = { dashboardFinancialSnapshot: jest.fn() };
    const activityLogs = {
      getAuditLogs: jest.fn().mockResolvedValue({
        data: [],
        meta: {
          total: 0,
          page: 1,
          limit: 6,
          totalPages: 0,
          hasNextPage: false,
          hasPrevPage: false,
        },
      }),
    };
    const legacyAnalytics = {
      getAdminDashboard: jest.fn().mockResolvedValue({
        totalStudents: 10,
        pendingStudents: 1,
        approvedStudents: 9,
        totalTeachers: 4,
        pendingTeachers: 2,
        approvedTeachers: 2,
        totalLessons: 7,
        totalBooks: 10,
        totalExams: 9,
        totalRevenue: 0,
        revenueThisMonth: 0,
        revenueLastMonth: 0,
        revenueToday: 0,
        revenueThisQuarter: 0,
        revenueBySource: { lessons: 0, packages: 0, books: 0 },
      }),
    };

    const service = new AdminDashboardService(
      users as unknown as Repository<never>,
      dataSource as unknown as DataSource,
      cache as never,
      payments as never,
      activityLogs as never,
      legacyAnalytics as never,
    );
    const result = await service.getDashboard(
      { userId: 'admin-1', email: 'admin@test', name: 'Admin', role: 'admin' },
      30,
    );

    expect(result.finance).toEqual({ status: 'forbidden', summaries: [], trends: [] });
    expect(result.attention.manualPaymentsAwaitingReview).toBeNull();
    expect(result.attention.draftSettlementsAwaitingApproval).toBeNull();
    expect(payments.dashboardFinancialSnapshot).not.toHaveBeenCalled();
    expect(legacyAnalytics.getAdminDashboard).not.toHaveBeenCalled();
    expect(cache.getOrCompute).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'principal:admin-1:permissions:none', parts: [30] }),
      expect.any(Function),
    );
  });

  it('keeps fulfilled sections when an independent support aggregate fails', async () => {
    const userBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({
        id: 'admin-2',
        finance_permissions: ['reports.view', 'settlements.view'],
      }),
    };
    const dataSource = {
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('FROM complaints')) throw new Error('support unavailable');
        if (sql.includes('manual_payments_awaiting_review'))
          return [
            {
              manual_payments_awaiting_review: '2',
              draft_settlements_awaiting_approval: '1',
              approved_settlements_awaiting_payment: '3',
            },
          ];
        return [
          {
            student_accounts: '10',
            teacher_accounts: '4',
            pending_students: '1',
            pending_teachers: '2',
            pending_subjects: '3',
            new_accounts: '5',
            active_learners: '6',
            lessons: '7',
            packages: '8',
            exams: '9',
            books: '10',
            lesson_views: '11',
            exam_attempts: '12',
            average_session_duration_seconds: '120',
            lesson_completion_rate: '75.5',
          },
        ];
      }),
    };
    const cache = {
      getOrCompute: jest
        .fn()
        .mockImplementation(
          async (_descriptor: unknown, compute: () => Promise<unknown>) => await compute(),
        ),
    };
    const payments = {
      dashboardFinancialSnapshot: jest.fn().mockResolvedValue({
        summaries: [
          {
            currency: 'EGP',
            orderCount: 2,
            grossSalesMinor: '1000',
            platformRevenueMinor: '200',
            teacherEarningsMinor: '800',
            refundsMinor: '0',
            netPlatformRevenueMinor: '200',
            averageOrderValueMinor: '500',
            outstandingTeacherPayablesMinor: '300',
            revenueChangeMinor: '100',
            revenueGrowthBps: '1000',
          },
        ],
        trends: [],
      }),
    };
    const activityLogs = {
      getAuditLogs: jest.fn().mockResolvedValue({
        data: [],
        meta: {
          total: 0,
          page: 1,
          limit: 6,
          totalPages: 0,
          hasNextPage: false,
          hasPrevPage: false,
        },
      }),
    };
    const legacyAnalytics = {
      getAdminDashboard: jest.fn().mockResolvedValue({
        totalStudents: 10,
        pendingStudents: 1,
        approvedStudents: 9,
        totalTeachers: 4,
        pendingTeachers: 2,
        approvedTeachers: 2,
        totalLessons: 7,
        totalBooks: 10,
        totalExams: 9,
        totalRevenue: 10,
        revenueThisMonth: 10,
        revenueLastMonth: 0,
        revenueToday: 0,
        revenueThisQuarter: 10,
        revenueBySource: { lessons: 10, packages: 0, books: 0 },
      }),
    };
    const service = new AdminDashboardService(
      {
        createQueryBuilder: jest.fn().mockReturnValue(userBuilder),
      } as unknown as Repository<never>,
      dataSource as unknown as DataSource,
      cache as never,
      payments as never,
      activityLogs as never,
      legacyAnalytics as never,
    );

    const result = await service.getDashboard(
      { userId: 'admin-2', email: 'owner@test', name: 'Owner', role: 'admin' },
      7,
    );

    expect(result.sectionErrors).toEqual(['support']);
    expect(result.kpis.activeLearners).toBe(6);
    expect(result.finance.status).toBe('available');
    expect(result.finance.summaries[0]?.grossSalesMinor).toBe('1000');
    expect(result.attention.overdueSupportTickets).toBe(0);
    expect(payments.dashboardFinancialSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ start: expect.any(Date), end: expect.any(Date) }),
      true,
    );
  });

  it('reads permissions from the principal without querying users', async () => {
    const users = { createQueryBuilder: jest.fn() };
    const dataSource = { query: jest.fn().mockResolvedValue([{}]) };
    const cache = {
      getOrCompute: jest.fn().mockResolvedValue({ cached: true }),
    };
    const service = new AdminDashboardService(
      users as unknown as Repository<never>,
      dataSource as unknown as DataSource,
      cache as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.getDashboard(
      {
        userId: 'admin-3',
        email: 'a@test',
        name: 'A',
        role: 'admin',
        financePermissions: ['settlements.view', 'reports.view'],
      },
      30,
    );

    expect(users.createQueryBuilder).not.toHaveBeenCalled();
    expect(cache.getOrCompute).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'principal:admin-3:permissions:reports.view,settlements.view',
      }),
      expect.any(Function),
    );
  });
});
