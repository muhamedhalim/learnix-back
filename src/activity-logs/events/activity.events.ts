/**
 * Base class for all activity events
 */
export abstract class ActivityEvent {
  constructor(
    public readonly userId: string,
    public readonly action: string,
    public readonly resourceType: string,
    public readonly resourceId: string | null = null,
    public readonly details: Record<string, unknown> | null = null,
    public readonly ipAddress: string | null = null,
    public readonly userAgent: string | null = null,
  ) {}
}

/**
 * Purchase-related events
 */
export class LessonPurchasedEvent extends ActivityEvent {
  constructor(
    userId: string,
    lessonId: string,
    details: { lessonTitle: string; price: number; paymentMethod: string },
    ipAddress?: string,
    userAgent?: string,
  ) {
    super(
      userId,
      'lesson_purchased',
      'lesson',
      lessonId,
      details,
      ipAddress ?? null,
      userAgent ?? null,
    );
  }
}

export class PackagePurchasedEvent extends ActivityEvent {
  constructor(
    userId: string,
    packageId: string,
    details: { packageTitle: string; price: number; lessonCount: number },
    ipAddress?: string,
    userAgent?: string,
  ) {
    super(
      userId,
      'package_purchased',
      'package',
      packageId,
      details,
      ipAddress ?? null,
      userAgent ?? null,
    );
  }
}

/**
 * Exam-related events
 */
export class ExamStartedEvent extends ActivityEvent {
  constructor(
    userId: string,
    examId: string,
    details: { examTitle: string; attemptId: string },
    ipAddress?: string,
    userAgent?: string,
  ) {
    super(
      userId,
      'exam_started',
      'exam',
      examId,
      details,
      ipAddress ?? null,
      userAgent ?? null,
    );
  }
}

export class ExamSubmittedEvent extends ActivityEvent {
  constructor(
    userId: string,
    examId: string,
    details: {
      examTitle: string;
      attemptId: string;
      scoreMcq: number;
      essayPending: boolean;
    },
    ipAddress?: string,
    userAgent?: string,
  ) {
    super(
      userId,
      'exam_submitted',
      'exam',
      examId,
      details,
      ipAddress ?? null,
      userAgent ?? null,
    );
  }
}

/**
 * Attendance code events
 */
export class AttendanceCodeRedeemedEvent extends ActivityEvent {
  constructor(
    userId: string,
    codeId: string,
    details: {
      code: string;
      itemType: string;
      itemId: string;
      itemTitle: string;
    },
    ipAddress?: string,
    userAgent?: string,
  ) {
    super(
      userId,
      'attendance_code_redeemed',
      'attendance_code',
      codeId,
      details,
      ipAddress ?? null,
      userAgent ?? null,
    );
  }
}

/**
 * Lesson session events
 */
export class LessonSessionStartedEvent extends ActivityEvent {
  constructor(
    userId: string,
    lessonId: string,
    details: { sessionId: string; lessonTitle: string },
    ipAddress?: string,
    userAgent?: string,
  ) {
    super(
      userId,
      'lesson_session_started',
      'lesson',
      lessonId,
      details,
      ipAddress ?? null,
      userAgent ?? null,
    );
  }
}

export class LessonSessionEndedEvent extends ActivityEvent {
  constructor(
    userId: string,
    lessonId: string,
    details: {
      sessionId: string;
      durationSeconds: number;
      videoProgressPercent: number;
    },
    ipAddress?: string,
    userAgent?: string,
  ) {
    super(
      userId,
      'lesson_session_ended',
      'lesson',
      lessonId,
      details,
      ipAddress ?? null,
      userAgent ?? null,
    );
  }
}

/**
 * Review events
 */
export class ReviewCreatedEvent extends ActivityEvent {
  constructor(
    userId: string,
    reviewId: string,
    details: {
      resourceType: 'lesson' | 'teacher';
      resourceId: string;
      rating: number;
    },
    ipAddress?: string,
    userAgent?: string,
  ) {
    super(
      userId,
      'review_created',
      'review',
      reviewId,
      details,
      ipAddress ?? null,
      userAgent ?? null,
    );
  }
}

/**
 * Profile events
 */
export class ProfilePictureUploadedEvent extends ActivityEvent {
  constructor(
    userId: string,
    details: { url: string; thumbnailUrl: string },
    ipAddress?: string,
    userAgent?: string,
  ) {
    super(
      userId,
      'profile_picture_uploaded',
      'user',
      userId,
      details,
      ipAddress ?? null,
      userAgent ?? null,
    );
  }
}
