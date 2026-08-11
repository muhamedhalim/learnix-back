/**
 * Base class for all audit events (privileged actor actions — an admin, or a
 * teacher acting on content they own). `adminId` is the actor's `users.id`;
 * where an event can be raised by either, `details.actorRole` records which.
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
    details: {
      userName: string;
      userEmail: string;
      userRole: string;
      /** Free-text reviewer justification, when the caller collected one. */
      notes?: string;
    },
    ipAddress?: string,
  ) {
    super(adminId, 'user_approved', 'user', userId, details.userName, details, ipAddress ?? null);
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
    super(adminId, 'user_rejected', 'user', userId, details.userName, details, ipAddress ?? null);
  }
}

export class UserSuspendedEvent extends AuditEvent {
  constructor(
    adminId: string,
    userId: string,
    details: { userName: string; userEmail: string; reason?: string },
    ipAddress?: string,
  ) {
    super(adminId, 'user_suspended', 'user', userId, details.userName, details, ipAddress ?? null);
  }
}

export class UserActivatedEvent extends AuditEvent {
  constructor(
    adminId: string,
    userId: string,
    details: { userName: string; userEmail: string },
    ipAddress?: string,
  ) {
    super(adminId, 'user_activated', 'user', userId, details.userName, details, ipAddress ?? null);
  }
}

/** Admin provisioned a new non-technical Call Center employee. */
export class CallCenterEmployeeCreatedEvent extends AuditEvent {
  constructor(
    adminId: string,
    userId: string,
    details: { userName: string; userRole: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'call_center_employee_created',
      'user',
      userId,
      details.userName,
      details,
      ipAddress ?? null,
    );
  }
}

/** Admin changed an existing account into a Call Center employee. */
export class CallCenterRoleAssignedEvent extends AuditEvent {
  constructor(
    adminId: string,
    userId: string,
    details: {
      userName: string;
      previousRole: string;
      previousStatus?: string;
      wasActive?: boolean;
      reason?: string;
    },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'call_center_role_assigned',
      'user',
      userId,
      details.userName,
      {
        previousRole: details.previousRole,
        newRole: 'call_center',
        ...(details.previousStatus !== undefined ? { previousStatus: details.previousStatus } : {}),
        ...(details.wasActive !== undefined ? { wasActive: details.wasActive } : {}),
        ...(details.reason !== undefined && details.reason !== ''
          ? { reason: details.reason }
          : {}),
      },
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
 * Subject catalogue events.
 *
 * `audit_logs.target_name` is varchar(200) while `subjects.name` is
 * varchar(255), so every constructor below truncates the name rather than
 * leaving a 22001 to surface at insert time.
 */
const SUBJECT_TARGET_TYPE = 'subject';
const TARGET_NAME_MAX = 200;

/** Actor that raised a subject event — teachers manage their own submissions. */
export type SubjectActorRole = 'admin' | 'teacher';

export class SubjectCreatedEvent extends AuditEvent {
  constructor(
    actorId: string,
    subjectId: string,
    details: { name: string; actorRole: SubjectActorRole; status: string },
    ipAddress?: string,
  ) {
    super(
      actorId,
      'subject_created',
      SUBJECT_TARGET_TYPE,
      subjectId,
      details.name.slice(0, TARGET_NAME_MAX),
      details,
      ipAddress ?? null,
    );
  }
}

export class SubjectUpdatedEvent extends AuditEvent {
  constructor(
    actorId: string,
    subjectId: string,
    details: { name: string; actorRole: SubjectActorRole; changedFields: string[] },
    ipAddress?: string,
  ) {
    super(
      actorId,
      'subject_updated',
      SUBJECT_TARGET_TYPE,
      subjectId,
      details.name.slice(0, TARGET_NAME_MAX),
      details,
      ipAddress ?? null,
    );
  }
}

export class SubjectDeletedEvent extends AuditEvent {
  constructor(
    actorId: string,
    subjectId: string,
    details: { name: string; actorRole: SubjectActorRole },
    ipAddress?: string,
  ) {
    super(
      actorId,
      'subject_deleted',
      SUBJECT_TARGET_TYPE,
      subjectId,
      details.name.slice(0, TARGET_NAME_MAX),
      details,
      ipAddress ?? null,
    );
  }
}

export class SubjectApprovedEvent extends AuditEvent {
  constructor(
    adminId: string,
    subjectId: string,
    details: { name: string; ownerTeacherId: string | null; notes?: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'subject_approved',
      SUBJECT_TARGET_TYPE,
      subjectId,
      details.name.slice(0, TARGET_NAME_MAX),
      details,
      ipAddress ?? null,
    );
  }
}

export class SubjectRejectedEvent extends AuditEvent {
  constructor(
    adminId: string,
    subjectId: string,
    details: { name: string; ownerTeacherId: string | null; reason: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'subject_rejected',
      SUBJECT_TARGET_TYPE,
      subjectId,
      details.name.slice(0, TARGET_NAME_MAX),
      details,
      ipAddress ?? null,
    );
  }
}

export class SubjectSuspendedEvent extends AuditEvent {
  constructor(
    adminId: string,
    subjectId: string,
    details: { name: string; ownerTeacherId: string | null; reason: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'subject_suspended',
      SUBJECT_TARGET_TYPE,
      subjectId,
      details.name.slice(0, TARGET_NAME_MAX),
      details,
      ipAddress ?? null,
    );
  }
}

export class SubjectReactivatedEvent extends AuditEvent {
  constructor(
    adminId: string,
    subjectId: string,
    details: { name: string; ownerTeacherId: string | null; previousStatus: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'subject_reactivated',
      SUBJECT_TARGET_TYPE,
      subjectId,
      details.name.slice(0, TARGET_NAME_MAX),
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
    super(adminId, 'exam_graded', 'exam', examId, details.examTitle, details, ipAddress ?? null);
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
