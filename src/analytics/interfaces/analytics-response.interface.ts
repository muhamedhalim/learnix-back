/**
 * Analytics Response Interfaces
 * Define structured response types for all analytics endpoints
 */

export interface DateRange {
  startDate: Date;
  endDate: Date;
}

export interface UserStats {
  total: number;
  students: number;
  teachers: number;
  admins: number;
  callCenter: number;
  pending: number;
  approved: number;
  rejected: number;
  newThisMonth: number;
  newThisWeek: number;
}

export interface RevenueStats {
  total: number;
  thisMonth: number;
  lastMonth: number;
  thisWeek: number;
  growthPercentage: number;
  averageTransaction: number;
  totalTransactions: number;
  successfulTransactions: number;
  pendingTransactions: number;
  failedTransactions: number;
}

export interface EngagementStats {
  totalExamAttempts: number;
  completedExams: number;
  averageExamScore: number;
  passRate: number;
  totalLessonPurchases: number;
  activeLessonAccess: number;
  expiredLessonAccess: number;
}

export interface ContentStats {
  totalLessons: number;
  totalPackages: number;
  totalExams: number;
  totalSubjects: number;
  lessonsThisMonth: number;
  examsThisMonth: number;
}

export interface DashboardOverview {
  users: UserStats;
  revenue: RevenueStats;
  engagement: EngagementStats;
  content: ContentStats;
  period: DateRange;
  generatedAt: Date;
}

export interface UserGrowthTrend {
  date: string;
  students: number;
  teachers: number;
  total: number;
}

export interface UserAnalytics {
  stats: UserStats;
  growthTrends: UserGrowthTrend[];
  approvalRate: number;
  registrationsByRole: {
    role: string;
    count: number;
    percentage: number;
  }[];
  period: DateRange;
}

export interface RevenueTrend {
  date: string;
  amount: number;
  transactionCount: number;
}

export interface RevenueBySubject {
  subjectId: number;
  subjectName: string;
  revenue: number;
  transactionCount: number;
  percentage: number;
}

export interface RevenueByTeacher {
  teacherId: number;
  teacherName: string;
  revenue: number;
  lessonsSold: number;
  packagesSold: number;
}

export interface RevenueAnalytics {
  stats: RevenueStats;
  trends: RevenueTrend[];
  bySubject: RevenueBySubject[];
  topTeachers: RevenueByTeacher[];
  period: DateRange;
}

export interface ExamEngagement {
  examId: number;
  examTitle: string;
  attempts: number;
  averageScore: number;
  passRate: number;
}

export interface LessonEngagement {
  lessonId: number;
  lessonTitle: string;
  teacherName: string;
  purchases: number;
  activeAccess: number;
}

export interface EngagementAnalytics {
  stats: EngagementStats;
  topExams: ExamEngagement[];
  topLessons: LessonEngagement[];
  examCompletionTrend: { date: string; completed: number }[];
  period: DateRange;
}

export interface PopularLesson {
  id: number;
  title: string;
  teacherName: string;
  subjectName: string;
  studentsCount: number;
  revenue: number;
  rating: number;
}

export interface PopularSubject {
  id: number;
  name: string;
  lessonsCount: number;
  studentsCount: number;
  revenue: number;
}

export interface ContentAnalytics {
  stats: ContentStats;
  popularLessons: PopularLesson[];
  popularSubjects: PopularSubject[];
  contentCreationTrend: { date: string; lessons: number; exams: number }[];
  period: DateRange;
}

export interface ActivityItem {
  id: number;
  type:
    | 'user_registered'
    | 'user_approved'
    | 'user_rejected'
    | 'lesson_purchased'
    | 'package_purchased'
    | 'exam_submitted'
    | 'exam_graded'
    | 'lesson_created'
    | 'payment_completed';
  description: string;
  userId?: number;
  userName?: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export interface RecentActivity {
  activities: ActivityItem[];
  totalCount: number;
}
