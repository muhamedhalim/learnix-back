/**
 * Base class for all audit events (admin actions)
 */
export abstract class AuditEvent {
  constructor(
    public readonly adminId: string,
    public readonly action: string,
    public readonly targetType: string,
    public readonly targetId: string | null = null,
    public readonly targetName: string | null = null,
    public readonly details: Record<string, unknown> | null = null,
    public readonly ipAddress: string | null = null,
  ) {}
}

/**
 * User approval events
 */
export class UserApprovedEvent extends AuditEvent {
  constructor(
    adminId: string,
    userId: string,
    details: { userName: string; userEmail: string; userRole: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'user_approved',
      'user',
      userId,
      details.userName,
      details,
      ipAddress ?? null,
    );
  }
}

export class UserRejectedEvent extends AuditEvent {
  constructor(
    adminId: string,
    userId: string,
    details: {
      userName: string;
      userEmail: string;
      userRole: string;
      reason: string;
    },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'user_rejected',
      'user',
      userId,
      details.userName,
      details,
      ipAddress ?? null,
    );
  }
}

export class UserSuspendedEvent extends AuditEvent {
  constructor(
    adminId: string,
    userId: string,
    details: { userName: string; userEmail: string; reason?: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'user_suspended',
      'user',
      userId,
      details.userName,
      details,
      ipAddress ?? null,
    );
  }
}

export class UserActivatedEvent extends AuditEvent {
  constructor(
    adminId: string,
    userId: string,
    details: { userName: string; userEmail: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'user_activated',
      'user',
      userId,
      details.userName,
      details,
      ipAddress ?? null,
    );
  }
}

/**
 * Content moderation events
 */
export class ContentApprovedEvent extends AuditEvent {
  constructor(
    adminId: string,
    contentType: string,
    contentId: string,
    details: { title: string; teacherId: string; teacherName: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'content_approved',
      contentType,
      contentId,
      details.title,
      details,
      ipAddress ?? null,
    );
  }
}

export class ContentRejectedEvent extends AuditEvent {
  constructor(
    adminId: string,
    contentType: string,
    contentId: string,
    details: { title: string; teacherId: string; reason: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'content_rejected',
      contentType,
      contentId,
      details.title,
      details,
      ipAddress ?? null,
    );
  }
}

/**
 * Attendance code events
 */
export class AttendanceCodesGeneratedEvent extends AuditEvent {
  constructor(
    adminId: string,
    details: {
      count: number;
      type: string;
      itemId: string;
      itemTitle: string;
      expiresAt: Date;
    },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'attendance_codes_generated',
      'attendance_code',
      null,
      `${String(details.count)} codes for ${details.itemTitle}`,
      details,
      ipAddress ?? null,
    );
  }
}

export class AttendanceCodeDeactivatedEvent extends AuditEvent {
  constructor(
    adminId: string,
    codeId: string,
    details: { code: string; itemType: string; itemId: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'attendance_code_deactivated',
      'attendance_code',
      codeId,
      details.code,
      details,
      ipAddress ?? null,
    );
  }
}

/**
 * Exam grading events
 */
export class ExamGradedEvent extends AuditEvent {
  constructor(
    adminId: string,
    examId: string,
    details: {
      examTitle: string;
      studentId: string;
      studentName: string;
      questionIndex: number;
      score: number;
    },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'exam_graded',
      'exam',
      examId,
      details.examTitle,
      details,
      ipAddress ?? null,
    );
  }
}

/**
 * Bulk operation events
 */
export class BulkOperationCompletedEvent extends AuditEvent {
  constructor(
    adminId: string,
    details: {
      operationType: string;
      totalProcessed: number;
      successCount: number;
      failedCount: number;
    },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'bulk_operation_completed',
      'system',
      null,
      `${details.operationType}: ${String(details.successCount)}/${String(details.totalProcessed)} succeeded`,
      details,
      ipAddress ?? null,
    );
  }
}
