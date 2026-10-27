import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { ActivityLogsService } from '../activity-logs/activity-logs.service';
import { ApplicationCacheService } from '../common/cache/application-cache.service';
import type { JwtPayload } from '../common/interfaces/user-request.interface';
import type { FinancePermission } from '../payments/finance-permissions';
import {
  FinancialReportsService,
  type DashboardFinancialSnapshot,
} from '../payments/services/financial-reports.service';
import { User } from '../users/entities/user.entity';
import { AnalyticsService } from './analytics.service';
import type { AdminDashboardDto, LegacyAdminDashboardDto } from './dto';

type SectionId = 'platform' | 'support' | 'finance' | 'attention' | 'audit';

interface PlatformRow {
  student_accounts: string;
  teacher_accounts: string;
  pending_students: string;
  pending_teachers: string;
  pending_subjects: string;
  new_accounts: string;
  active_learners: string;
  lessons: string;
  packages: string;
  exams: string;
  books: string;
  lesson_views: string;
  exam_attempts: string;
  average_session_duration_seconds: string;
  lesson_completion_rate: string;
}

interface SupportRow {
  overdue_support_tickets: string;
  unassigned_open_support_tickets: string;
}

interface AttentionRow {
  manual_payments_awaiting_review: string | null;
  draft_settlements_awaiting_approval: string | null;
  approved_settlements_awaiting_payment: string | null;
}

@Injectable()
export class AdminDashboardService {
  private readonly logger = new Logger(AdminDashboardService.name);

  public constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly cache: ApplicationCacheService,
    private readonly payments: FinancialReportsService,
    private readonly activityLogs: ActivityLogsService,
    private readonly legacyAnalytics: AnalyticsService,
  ) {}

  public async getDashboard(user: JwtPayload, requestedDays: number): Promise<AdminDashboardDto> {
    const days = requestedDays === 7 ? 7 : 30;
    const permissions = await this.loadPermissions(user);
    const permissionFingerprint = [...permissions].sort().join(',') || 'none';

    return await this.cache.getOrCompute(
      {
        family: 'admin_dashboard',
        endpoint: 'analytics.admin.dashboard.v3',
        tenant: user.tenantId,
        scope: `principal:${user.userId}:permissions:${permissionFingerprint}`,
        parts: [days],
        ttlMs: 60_000,
      },
      async () => await this.assemble(user, days, permissions),
    );
  }

  private async assemble(
    user: JwtPayload,
    days: 7 | 30,
    permissions: readonly FinancePermission[],
  ): Promise<AdminDashboardDto> {
    const generatedAt = new Date();
    const durationMs = days * 24 * 60 * 60 * 1000;
    const end = generatedAt;
    const start = new Date(end.getTime() - durationMs);
    const previousEnd = new Date(start);
    const previousStart = new Date(previousEnd.getTime() - durationMs);
    const canViewReports = permissions.includes('reports.view');
    const canViewSettlements = permissions.includes('settlements.view');

    const tasks = {
      platform: this.loadPlatform(start, end),
      support: this.loadSupportAttention(),
      attention: this.loadFinanceAttention(canViewReports, canViewSettlements),
      finance: canViewReports
        ? this.payments.dashboardFinancialSnapshot(
            { start, end, previousStart, previousEnd },
            canViewSettlements,
          )
        : Promise.resolve<DashboardFinancialSnapshot>({ summaries: [], trends: [] }),
      audit: this.activityLogs.getAuditLogs({ page: 1, limit: 6 }),
      legacy: canViewReports
        ? this.legacyAnalytics.getAdminDashboard(user.tenantId)
        : Promise.resolve<LegacyAdminDashboardDto | undefined>(undefined),
    };
    const keys = Object.keys(tasks) as Array<keyof typeof tasks>;
    const settled = await Promise.allSettled(keys.map((key) => tasks[key]));
    const results = Object.fromEntries(keys.map((key, index) => [key, settled[index]])) as {
      [K in keyof typeof tasks]: PromiseSettledResult<Awaited<(typeof tasks)[K]>>;
    };

    const sectionErrors = (
      ['platform', 'support', 'attention', 'finance', 'audit'] as SectionId[]
    ).filter((section) =>
      section === 'finance' && !canViewReports ? false : results[section].status === 'rejected',
    );
    for (const section of sectionErrors) {
      const result = results[section];
      this.logger.warn(
        `Admin dashboard section failed: ${section}`,
        result.status === 'rejected' ? result.reason : undefined,
      );
    }

    const platform = this.value(results.platform, this.emptyPlatform());
    const support = this.value(results.support, {
      overdue_support_tickets: '0',
      unassigned_open_support_tickets: '0',
    });
    const attention = this.value(results.attention, {
      manual_payments_awaiting_review: canViewReports ? '0' : null,
      draft_settlements_awaiting_approval: canViewSettlements ? '0' : null,
      approved_settlements_awaiting_payment: canViewSettlements ? '0' : null,
    });
    const finance = this.value(results.finance, { summaries: [], trends: [] });
    const audit = this.value(results.audit, {
      data: [],
      meta: { total: 0, page: 1, limit: 6, totalPages: 0, hasNextPage: false, hasPrevPage: false },
    });
    const legacy = this.value(results.legacy, undefined);
    const number = (value: string | number | null | undefined): number => Number(value ?? 0);

    return {
      generatedAt: generatedAt.toISOString(),
      period: {
        days,
        from: start.toISOString(),
        to: end.toISOString(),
        previousFrom: previousStart.toISOString(),
        previousTo: previousEnd.toISOString(),
      },
      kpis: {
        activeLearners: number(platform.active_learners),
        newAccounts: number(platform.new_accounts),
        grossSales: finance.summaries.map((row) => ({
          currency: row.currency,
          amountMinor: row.grossSalesMinor,
        })),
        paidOrders: finance.summaries.map((row) => ({
          currency: row.currency,
          count: row.orderCount,
        })),
      },
      inventory: {
        studentAccounts: number(platform.student_accounts),
        teacherAccounts: number(platform.teacher_accounts),
        lessons: number(platform.lessons),
        packages: number(platform.packages),
        exams: number(platform.exams),
        books: number(platform.books),
      },
      activity: {
        lessonViews: number(platform.lesson_views),
        examAttempts: number(platform.exam_attempts),
        averageSessionDurationSeconds: number(platform.average_session_duration_seconds),
        lessonCompletionRate: number(platform.lesson_completion_rate),
      },
      attention: {
        pendingStudents: number(platform.pending_students),
        pendingTeachers: number(platform.pending_teachers),
        pendingSubjects: number(platform.pending_subjects),
        overdueSupportTickets: number(support.overdue_support_tickets),
        unassignedOpenSupportTickets: number(support.unassigned_open_support_tickets),
        manualPaymentsAwaitingReview:
          attention.manual_payments_awaiting_review == null
            ? null
            : number(attention.manual_payments_awaiting_review),
        draftSettlementsAwaitingApproval:
          attention.draft_settlements_awaiting_approval == null
            ? null
            : number(attention.draft_settlements_awaiting_approval),
        approvedSettlementsAwaitingPayment:
          attention.approved_settlements_awaiting_payment == null
            ? null
            : number(attention.approved_settlements_awaiting_payment),
      },
      finance: {
        status: !canViewReports
          ? 'forbidden'
          : results.finance.status === 'rejected'
            ? 'failed'
            : 'available',
        summaries: finance.summaries,
        trends: finance.trends,
      },
      recentAdminActivity: audit.data.map((entry) => ({
        id: entry.id,
        actor: {
          id: entry.admin_id,
          name: entry.admin?.name ?? '',
          email: entry.admin?.email ?? '',
        },
        action: entry.action,
        targetType: entry.target_type,
        targetId: entry.target_id,
        targetName: entry.target_name,
        createdAt: entry.created_at.toISOString(),
      })),
      sectionErrors,
      totalStudents: legacy?.totalStudents ?? number(platform.student_accounts),
      pendingStudents: legacy?.pendingStudents ?? number(platform.pending_students),
      approvedStudents: legacy?.approvedStudents ?? 0,
      totalTeachers: legacy?.totalTeachers ?? number(platform.teacher_accounts),
      pendingTeachers: legacy?.pendingTeachers ?? number(platform.pending_teachers),
      approvedTeachers: legacy?.approvedTeachers ?? 0,
      totalLessons: legacy?.totalLessons ?? number(platform.lessons),
      totalBooks: legacy?.totalBooks ?? number(platform.books),
      totalExams: legacy?.totalExams ?? number(platform.exams),
      totalRevenue: legacy?.totalRevenue ?? 0,
      revenueThisMonth: legacy?.revenueThisMonth ?? 0,
      revenueLastMonth: legacy?.revenueLastMonth ?? 0,
      revenueToday: legacy?.revenueToday ?? 0,
      revenueThisQuarter: legacy?.revenueThisQuarter ?? 0,
      revenueBySource: legacy?.revenueBySource ?? { lessons: 0, packages: 0, books: 0 },
    };
  }

  private async loadPermissions(principal: JwtPayload): Promise<FinancePermission[]> {
    // Cookie-authenticated principals already carry the live permissions from
    // the single session/user statement; only other principals need a read.
    if (Array.isArray(principal.financePermissions)) return principal.financePermissions;
    const userId = principal.userId;
    const user = await this.users
      .createQueryBuilder('user')
      .select(['user.id', 'user.finance_permissions'])
      .where('user.id = :userId', { userId })
      .getOne();
    return Array.isArray(user?.finance_permissions) ? user.finance_permissions : [];
  }

  private async loadPlatform(start: Date, end: Date): Promise<PlatformRow> {
    const rows = (await this.dataSource.query(
      `
      WITH session_window AS (
        SELECT COUNT(DISTINCT student_id) AS active_learners,
               COUNT(*) AS lesson_views,
               AVG(duration_seconds) AS average_duration,
               COUNT(*) FILTER (WHERE video_progress_percent >= 90) AS completed_views
        FROM lesson_sessions WHERE entered_at >= $1 AND entered_at < $2
      )
      SELECT
        (SELECT COUNT(*) FROM users WHERE role = 'student' AND deleted_at IS NULL)::text AS student_accounts,
        (SELECT COUNT(*) FROM users WHERE role = 'teacher' AND deleted_at IS NULL)::text AS teacher_accounts,
        (SELECT COUNT(*) FROM users WHERE role = 'student' AND status = 'pending' AND deleted_at IS NULL)::text AS pending_students,
        (SELECT COUNT(*) FROM users WHERE role = 'teacher' AND status = 'pending' AND deleted_at IS NULL)::text AS pending_teachers,
        (SELECT COUNT(*) FROM subjects WHERE status = 'pending_approval' AND deleted_at IS NULL)::text AS pending_subjects,
        (SELECT COUNT(*) FROM users WHERE created_at >= $1 AND created_at < $2 AND deleted_at IS NULL)::text AS new_accounts,
        (SELECT active_learners FROM session_window)::text AS active_learners,
        (SELECT COUNT(*) FROM lessons WHERE deleted_at IS NULL)::text AS lessons,
        (SELECT COUNT(*) FROM lesson_packages WHERE deleted_at IS NULL)::text AS packages,
        (SELECT COUNT(*) FROM exams WHERE deleted_at IS NULL)::text AS exams,
        (SELECT COUNT(*) FROM books WHERE deleted_at IS NULL)::text AS books,
        (SELECT lesson_views FROM session_window)::text AS lesson_views,
        (SELECT COUNT(*) FROM exam_attempts WHERE created_at >= $1 AND created_at < $2)::text AS exam_attempts,
        (SELECT COALESCE(ROUND(average_duration), 0) FROM session_window)::text AS average_session_duration_seconds,
        (SELECT COALESCE(ROUND(completed_views::numeric * 100 / NULLIF(lesson_views, 0), 1), 0) FROM session_window)::text AS lesson_completion_rate
    `,
      [start, end],
    )) as PlatformRow[];
    return rows[0] ?? this.emptyPlatform();
  }

  private async loadSupportAttention(): Promise<SupportRow> {
    const rows = (await this.dataSource.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE status NOT IN ('resolved', 'closed')
            AND (first_response_due_at <= NOW() OR resolution_due_at <= NOW())
        )::text AS overdue_support_tickets,
        COUNT(*) FILTER (
          WHERE status NOT IN ('resolved', 'closed') AND assigned_agent_id IS NULL
        )::text AS unassigned_open_support_tickets
      FROM complaints WHERE deleted_at IS NULL
    `)) as SupportRow[];
    return rows[0] ?? { overdue_support_tickets: '0', unassigned_open_support_tickets: '0' };
  }

  private async loadFinanceAttention(
    canViewReports: boolean,
    canViewSettlements: boolean,
  ): Promise<AttentionRow> {
    const manual = canViewReports
      ? `(SELECT COUNT(*) FROM manual_payment_submissions WHERE status IN ('submitted', 'under_review'))::text`
      : 'NULL::text';
    const draft = canViewSettlements
      ? `(SELECT COUNT(*) FROM teacher_settlements WHERE status = 'draft')::text`
      : 'NULL::text';
    const approved = canViewSettlements
      ? `(SELECT COUNT(*) FROM teacher_settlements WHERE status = 'approved')::text`
      : 'NULL::text';
    const rows = (await this.dataSource.query(`
      SELECT ${manual} AS manual_payments_awaiting_review,
        ${draft} AS draft_settlements_awaiting_approval,
        ${approved} AS approved_settlements_awaiting_payment
    `)) as AttentionRow[];
    return (
      rows[0] ?? {
        manual_payments_awaiting_review: canViewReports ? '0' : null,
        draft_settlements_awaiting_approval: canViewSettlements ? '0' : null,
        approved_settlements_awaiting_payment: canViewSettlements ? '0' : null,
      }
    );
  }

  private emptyPlatform(): PlatformRow {
    return {
      student_accounts: '0',
      teacher_accounts: '0',
      pending_students: '0',
      pending_teachers: '0',
      pending_subjects: '0',
      new_accounts: '0',
      active_learners: '0',
      lessons: '0',
      packages: '0',
      exams: '0',
      books: '0',
      lesson_views: '0',
      exam_attempts: '0',
      average_session_duration_seconds: '0',
      lesson_completion_rate: '0',
    };
  }

  private value<T>(result: PromiseSettledResult<T>, fallback: T): T {
    return result.status === 'fulfilled' ? result.value : fallback;
  }
}
