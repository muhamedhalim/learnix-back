import { ParentEventType } from '../../common/events/parent-event-type.enum';

/**
 * Domain events that may result in a guardian being notified.
 *
 * These are *facts about the past*, not commands. A domain service emits one
 * after its transaction commits and then forgets about it. Nothing here knows
 * that WhatsApp exists, that a queue exists, or even that guardians exist —
 * `ParentNotificationListener` is the only subscriber, and all it does is
 * enqueue. That indirection is what stops a slow Twilio call from blocking a
 * student's exam submission, as the old inline `notifyAttendance` did.
 *
 * `subjectId` identifies the thing the event is about (an attempt, an
 * attendance record, a payment). It becomes part of the message idempotency
 * key, so re-emitting the same event for the same subject is a no-op.
 */
export interface ParentDomainEvent {
  readonly type: ParentEventType;
  readonly studentId: string;
  readonly subjectId: string;
  /** Template variables. Must be JSON-serialisable — this crosses Redis. */
  readonly variables: Record<string, unknown>;
}

export const PARENT_EVENT_CHANNEL = 'parent.notification';

export class ExamGradedEvent implements ParentDomainEvent {
  public readonly type = ParentEventType.EXAM_GRADED;

  constructor(
    public readonly studentId: string,
    /** The attempt id — one notification per attempt, not per exam. */
    public readonly subjectId: string,
    public readonly variables: {
      studentName: string;
      examName: string;
      score: number;
      totalMarks: number;
      percentage: number;
      passed: boolean;
      correctAnswers: number;
      wrongAnswers: number;
      rank: number | null;
      cohortSize: number | null;
      teacherNotes: string | null;
    },
  ) {}
}

export class AttendanceMarkedEvent implements ParentDomainEvent {
  public readonly type = ParentEventType.ATTENDANCE_MARKED;

  constructor(
    public readonly studentId: string,
    /** The attendance record id. */
    public readonly subjectId: string,
    public readonly variables: {
      studentName: string;
      lessonName: string;
      status: string;
      markedAt: string;
    },
  ) {}
}

export class HomeworkAssignedEvent implements ParentDomainEvent {
  public readonly type = ParentEventType.HOMEWORK_ASSIGNED;

  constructor(
    public readonly studentId: string,
    /** The homework id. */
    public readonly subjectId: string,
    public readonly variables: {
      studentName: string;
      lessonName: string;
      homeworkTitle: string;
      dueAt: string | null;
    },
  ) {}
}

export class LessonCompletedEvent implements ParentDomainEvent {
  public readonly type = ParentEventType.LESSON_COMPLETED;

  constructor(
    public readonly studentId: string,
    /** The lesson id. */
    public readonly subjectId: string,
    public readonly variables: {
      studentName: string;
      lessonName: string;
    },
  ) {}
}

export class TeacherMessageEvent implements ParentDomainEvent {
  public readonly type = ParentEventType.TEACHER_MESSAGE;

  constructor(
    public readonly studentId: string,
    /** A fresh id per send — a teacher broadcast is a deliberate one-off action, never deduplicated. */
    public readonly subjectId: string,
    public readonly variables: {
      studentName: string;
      teacherName: string;
      message: string;
    },
  ) {}
}

export class CoursePurchasedEvent implements ParentDomainEvent {
  public readonly type = ParentEventType.COURSE_PURCHASED;

  constructor(
    public readonly studentId: string,
    /** The payment id. */
    public readonly subjectId: string,
    public readonly variables: {
      studentName: string;
      itemName: string;
      amount: number;
      currency: string;
    },
  ) {}
}
