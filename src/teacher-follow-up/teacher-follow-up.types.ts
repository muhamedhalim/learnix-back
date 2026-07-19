import type { ParentEventType } from '../common/events/parent-event-type.enum';
import type { GuardianVerificationStatus } from '../guardians/entities';
import type { MessageChannel, ParentMessageStatus } from '../notifications/entities';

/**
 * Computed on every request from live aggregates — never persisted. A stored
 * "risk score" would drift the moment a new exam is graded or attendance is
 * marked, and would need its own invalidation story for no real benefit.
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface StudentGuardianSummary {
  guardianId: string;
  fullName: string | null;
  phoneE164: string;
  verificationStatus: GuardianVerificationStatus;
  whatsappCapable: boolean;
  optedOut: boolean;
  isPrimary: boolean;
}

export interface LastNotificationSummary {
  eventType: ParentEventType;
  channel: MessageChannel;
  status: ParentMessageStatus;
  createdAt: string;
}

export interface AttendanceSummary {
  total: number;
  rate: number | null;
  lastStatus: string | null;
  lastMarkedAt: string | null;
}

export interface LatestExamSummary {
  examName: string;
  score: number;
  maxScore: number;
  percentage: number;
  passed: boolean | null;
  gradedAt: string;
}

export interface HomeworkSummary {
  assigned: number;
  submitted: number;
  graded: number;
  late: number;
  completionRate: number | null;
  averageScore: number | null;
  lastSubmittedAt: string | null;
}

export interface RiskAssessment {
  level: RiskLevel;
  factors: string[];
}

export interface TeacherStudentSummary {
  id: string;
  name: string;
  email: string;
  phone: string;
  guardian: StudentGuardianSummary | null;
  lastNotification: LastNotificationSummary | null;
  lastReadAt: string | null;
  attendance: AttendanceSummary;
  latestExam: LatestExamSummary | null;
  averageExamScore: number | null;
  homework: HomeworkSummary;
  risk: RiskAssessment;
}

export type TimelineEntryType =
  | 'exam_started'
  | 'exam_submitted'
  | 'exam_graded'
  | 'attendance_recorded'
  | 'homework_submitted'
  | 'homework_graded'
  | 'notification_queued'
  | 'notification_sent'
  | 'notification_delivered'
  | 'notification_read';

export interface TimelineEntry {
  type: TimelineEntryType;
  label: string;
  at: string;
  meta?: Record<string, unknown>;
}
