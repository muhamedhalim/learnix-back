import { ApiProperty } from '@nestjs/swagger';

export class RevenueBySourceDto {
  @ApiProperty({ example: 75_000 })
  public lessons!: number;

  @ApiProperty({ example: 35_000 })
  public packages!: number;

  @ApiProperty({ example: 15_000 })
  public books!: number;
}

export type AdminDashboardFinanceStatus = 'available' | 'forbidden' | 'failed';

export interface AdminDashboardPeriodDto {
  days: 7 | 30;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
}

export interface AdminDashboardMoneyMetricDto {
  currency: string;
  amountMinor: string;
}

export interface AdminDashboardOrderMetricDto {
  currency: string;
  count: number;
}

export interface AdminDashboardFinanceSummaryDto {
  currency: string;
  orderCount: number;
  grossSalesMinor: string;
  platformRevenueMinor: string;
  teacherEarningsMinor: string;
  refundsMinor: string;
  netPlatformRevenueMinor: string;
  averageOrderValueMinor: string;
  outstandingTeacherPayablesMinor: string | null;
  revenueChangeMinor: string;
  revenueGrowthBps: string | null;
}

export interface AdminDashboardFinanceTrendDto {
  date: string;
  currency: string;
  orderCount: number;
  grossSalesMinor: string;
  platformRevenueMinor: string;
  teacherEarningsMinor: string;
}

export interface AdminDashboardAuditEntryDto {
  id: string;
  actor: { id: string; name: string; email: string };
  action: string;
  targetType: string;
  targetId: string | null;
  targetName: string | null;
  createdAt: string;
}

export interface LegacyAdminDashboardDto {
  totalStudents: number;
  pendingStudents: number;
  approvedStudents: number;
  totalTeachers: number;
  pendingTeachers: number;
  approvedTeachers: number;
  totalLessons: number;
  totalBooks: number;
  totalExams: number;
  totalRevenue: number;
  revenueThisMonth: number;
  revenueLastMonth: number;
  revenueToday: number;
  revenueThisQuarter: number;
  revenueBySource: RevenueBySourceDto;
}

/**
 * Response DTO for admin dashboard statistics
 */
export class AdminDashboardDto {
  @ApiProperty({ format: 'date-time' })
  public generatedAt!: string;

  @ApiProperty({ type: Object })
  public period!: AdminDashboardPeriodDto;

  @ApiProperty({ type: Object })
  public kpis!: {
    activeLearners: number;
    newAccounts: number;
    grossSales: AdminDashboardMoneyMetricDto[];
    paidOrders: AdminDashboardOrderMetricDto[];
  };

  @ApiProperty({ type: Object })
  public inventory!: {
    studentAccounts: number;
    teacherAccounts: number;
    lessons: number;
    packages: number;
    exams: number;
    books: number;
  };

  @ApiProperty({ type: Object })
  public activity!: {
    lessonViews: number;
    examAttempts: number;
    averageSessionDurationSeconds: number;
    lessonCompletionRate: number;
  };

  @ApiProperty({ type: Object })
  public attention!: {
    pendingStudents: number;
    pendingTeachers: number;
    pendingSubjects: number;
    overdueSupportTickets: number;
    unassignedOpenSupportTickets: number;
    manualPaymentsAwaitingReview: number | null;
    draftSettlementsAwaitingApproval: number | null;
    approvedSettlementsAwaitingPayment: number | null;
  };

  @ApiProperty({ type: Object })
  public finance!: {
    status: AdminDashboardFinanceStatus;
    summaries: AdminDashboardFinanceSummaryDto[];
    trends: AdminDashboardFinanceTrendDto[];
  };

  @ApiProperty({ type: Object, isArray: true })
  public recentAdminActivity!: AdminDashboardAuditEntryDto[];

  @ApiProperty({ type: String, isArray: true })
  public sectionErrors!: string[];

  @ApiProperty({
    description: 'Total number of approved students',
    example: 150,
  })
  public totalStudents!: number;

  @ApiProperty({
    description: 'Number of students pending approval',
    example: 5,
  })
  public pendingStudents!: number;

  @ApiProperty({
    description: 'Number of approved students',
    example: 145,
  })
  public approvedStudents!: number;

  @ApiProperty({
    description: 'Total number of approved teachers',
    example: 20,
  })
  public totalTeachers!: number;

  @ApiProperty({
    description: 'Number of teachers pending approval',
    example: 2,
  })
  public pendingTeachers!: number;

  @ApiProperty({
    description: 'Number of approved teachers',
    example: 18,
  })
  public approvedTeachers!: number;

  @ApiProperty({
    description: 'Total number of active lessons',
    example: 75,
  })
  public totalLessons!: number;

  @ApiProperty({
    description: 'Total number of active books',
    example: 30,
  })
  public totalBooks!: number;

  @ApiProperty({
    description: 'Total number of active exams',
    example: 25,
  })
  public totalExams!: number;

  @ApiProperty({
    description: 'Total revenue from all completed transactions',
    example: 125_000.5,
  })
  public totalRevenue!: number;

  @ApiProperty({
    description: 'Revenue earned this month',
    example: 15_000,
  })
  public revenueThisMonth!: number;

  @ApiProperty({
    description: 'Revenue earned last month',
    example: 12_500,
  })
  public revenueLastMonth!: number;

  @ApiProperty({
    description: 'Revenue earned today (UTC)',
    example: 1_250,
  })
  public revenueToday!: number;

  @ApiProperty({
    description: 'Revenue earned this calendar quarter (UTC)',
    example: 42_000,
  })
  public revenueThisQuarter!: number;

  @ApiProperty({
    description: 'All-time completed revenue grouped by purchased item type',
    type: RevenueBySourceDto,
  })
  public revenueBySource!: RevenueBySourceDto;
}
