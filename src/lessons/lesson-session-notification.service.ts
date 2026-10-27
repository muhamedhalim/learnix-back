import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { DataSource } from 'typeorm';

import { CronSingleRunner } from '../common/utils/cron-lock.util';
import { retryTransaction } from '../common/utils/transaction-retry.util';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationOrigin } from '../notifications/entities/notification-origin.enum';
import { NotificationStatus } from '../notifications/entities/notification-status.enum';
import { NotificationType } from '../notifications/entities/notification-type.enum';
import { NotificationEmailService } from '../notifications/services/notification-email.service';
import { User } from '../users/entities/user.entity';
import { LessonSessionBookingStatus } from './entities/lesson-session-booking-status.enum';
import { LessonSessionBooking } from './entities/lesson-session-booking.entity';
import { ScheduledLessonSessionStatus } from './entities/scheduled-lesson-session-status.enum';
import { ScheduledLessonSession } from './entities/scheduled-lesson-session.entity';
import { TeacherMeetingAccount } from './entities/teacher-meeting-account.entity';

/**
 * Appointment notifications: the commit-observing confirmation/reminder/cancellation cron
 * (`lessons.session_notifications`) and the booking- and meeting-event notices, with their
 * bilingual copy. Extracted unchanged from `LessonSessionsService`; the cron schedule and its
 * cluster-lock name are the same. `LessonSessionsService` calls the public `notify*` methods
 * after its own transactions commit.
 */
@Injectable()
export class LessonSessionNotificationService {
  public constructor(
    private readonly dataSource: DataSource,
    /**
     * Optional notification mail, not raw transport. These session emails
     * merely mirror an in-app notification the user could read in the app, so
     * they are exactly what the "Email notifications" preference is for — and
     * routing them through this service is what makes that toggle real. Nothing
     * here is transactional or security-critical (see `NotificationEmailService`
     * for the enumerated boundary).
     */
    private readonly notificationEmail: NotificationEmailService,
  ) {}

  /**
   * Confirmation and reminder delivery is deliberately commit-observing: the
   * job only sees rows after their financial transaction has committed. The
   * notification dedupe key is the durable exactly-once gate for each event.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  @CronSingleRunner('lessons.session_notifications')
  public async dispatchScheduledSessionNotifications(): Promise<void> {
    const now = this.currentTime();
    // T070: a booking is a candidate only when some notification it could still
    // receive this run is missing, not merely because it starts within 24 h. The
    // SQL windows are a strict superset of the JS windows below: timestamptz keeps
    // microseconds while `Date` keeps milliseconds, so every boundary gets 1 ms of
    // slack. A candidate that turns out to need nothing only costs a deduped insert;
    // a booking the loop would notify can never be left out.
    const oneHourMs = 60 * 60_000;
    const horizonPlusSlack = new Date(now.getTime() + 24 * oneHourMs + 1);
    const oneHourMinusSlack = new Date(now.getTime() + oneHourMs - 1);
    const oneHourPlusSlack = new Date(now.getTime() + oneHourMs + 1);
    const missingKey = (event: string, recipientId: string): string => `NOT EXISTS (
          SELECT 1 FROM notifications notification
          WHERE notification.dedupe_key = CONCAT(
            'lesson-session:', session.id, ':booking:', booking.id, ':${event}:', ${recipientId}
          )
        )`;
    const bookings = await this.dataSource
      .getRepository(LessonSessionBooking)
      .createQueryBuilder('booking')
      .innerJoinAndSelect('booking.session', 'session')
      .innerJoinAndSelect('session.lesson', 'lesson')
      .innerJoinAndSelect('session.teacher', 'teacher')
      .innerJoinAndSelect('booking.student', 'student')
      .where('booking.status = :status', { status: LessonSessionBookingStatus.CONFIRMED })
      .andWhere(
        `(
        ${missingKey('confirmed', 'booking.student_id')}
        OR ${missingKey('confirmed', 'session.teacher_id')}
        OR (
          session.start_at > :oneHourMinusSlack AND session.start_at <= :horizonPlusSlack
          AND (
            ${missingKey('reminder_24h', 'booking.student_id')}
            OR ${missingKey('reminder_24h', 'session.teacher_id')}
          )
        )
        OR (
          session.start_at > :now AND session.start_at <= :oneHourPlusSlack
          AND (
            ${missingKey('reminder_1h', 'booking.student_id')}
            OR ${missingKey('reminder_1h', 'session.teacher_id')}
          )
        )
      )`,
        { now, oneHourMinusSlack, oneHourPlusSlack, horizonPlusSlack },
      )
      .getMany();
    for (const booking of bookings) {
      await this.notifyBookingEvent(booking.id, 'confirmed', booking);
      const untilStart = booking.session.start_at.getTime() - now.getTime();
      // Dedupe keys make these catch-up windows safe after process downtime.
      // The 24h reminder remains useful until the 1h reminder becomes due;
      // the 1h reminder remains useful until the session starts.
      if (untilStart > 60 * 60_000 && untilStart <= 24 * 60 * 60_000) {
        await this.notifyBookingEvent(booking.id, 'reminder_24h', booking);
      }
      if (untilStart > 0 && untilStart <= 60 * 60_000) {
        await this.notifyBookingEvent(booking.id, 'reminder_1h', booking);
      }
    }
    const cancelledBookings = await this.dataSource
      .getRepository(LessonSessionBooking)
      .createQueryBuilder('booking')
      .innerJoinAndSelect('booking.session', 'session')
      .innerJoinAndSelect('session.lesson', 'lesson')
      .innerJoinAndSelect('session.teacher', 'teacher')
      .innerJoinAndSelect('booking.student', 'student')
      .where('booking.status = :status', { status: LessonSessionBookingStatus.REFUNDED })
      .andWhere('session.status = :sessionStatus', {
        sessionStatus: ScheduledLessonSessionStatus.CANCELLED,
      })
      .andWhere(
        `(
        NOT EXISTS (
          SELECT 1 FROM notifications notification
          WHERE notification.dedupe_key = CONCAT(
            'lesson-session:', session.id, ':booking:', booking.id, ':cancelled:', booking.student_id
          )
        )
        OR NOT EXISTS (
          SELECT 1 FROM notifications notification
          WHERE notification.dedupe_key = CONCAT(
            'lesson-session:', session.id, ':booking:', booking.id, ':cancelled:', session.teacher_id
          )
        )
      )`,
      )
      .getMany();
    for (const booking of cancelledBookings) {
      await this.notifyBookingEvent(booking.id, 'cancelled', booking);
    }
  }

  /** The cron's clock, a seam so a test can pin the window boundaries exactly. */
  private currentTime(): Date {
    return new Date();
  }

  public async notifyBookingEvent(
    bookingId: string,
    event:
      | 'confirmed'
      | 'reminder_24h'
      | 'reminder_1h'
      | 'meeting_link_updated'
      | 'cancellation_pending'
      | 'cancelled',
    _loaded?: LessonSessionBooking,
  ): Promise<void> {
    const booking = await retryTransaction(this.dataSource, async (manager) => {
      const locked = await manager.findOne(LessonSessionBooking, {
        where: { id: bookingId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!locked) return null;
      if (
        ['confirmed', 'reminder_24h', 'reminder_1h', 'meeting_link_updated'].includes(event) &&
        locked.status !== LessonSessionBookingStatus.CONFIRMED
      ) {
        return null;
      }
      const current = await manager.findOne(LessonSessionBooking, {
        where: { id: bookingId },
        relations: ['session', 'session.lesson', 'session.teacher', 'student'],
      });
      if (
        event === 'cancellation_pending' &&
        current?.session.status !== ScheduledLessonSessionStatus.CANCELLATION_PENDING
      ) {
        return null;
      }
      if (
        event === 'cancelled' &&
        (current?.status !== LessonSessionBookingStatus.REFUNDED ||
          current.session.status !== ScheduledLessonSessionStatus.CANCELLED)
      ) {
        return null;
      }
      return current;
    });
    if (!booking) return;
    const session = booking.session;
    const student = booking.student as User;
    const teacher = session.teacher as User;
    const start = session.start_at.toISOString();
    for (const recipient of [student, teacher]) {
      if (!recipient) continue;
      const arabic = recipient.preferred_language === 'ar';
      const copy = this.notificationCopy(event, session.lesson.title, start, arabic);
      const meetingLine =
        recipient.id === teacher.id || booking.status === LessonSessionBookingStatus.CONFIRMED
          ? `\n${arabic ? 'رابط الاجتماع' : 'Meeting'}: ${session.meeting_url ?? (arabic ? 'غير محدد' : 'Not set')}`
          : '';
      await this.insertAndEmailNotification({
        dedupeKey: `lesson-session:${session.id}:booking:${booking.id}:${event}:${recipient.id}`,
        recipient,
        sourceEvent: `lesson_session_${event}`,
        title: copy.title,
        message: copy.message,
        data: {
          scheduled_lesson_session_id: session.id,
          lesson_id: session.lesson_id,
          booking_id: booking.id,
          event,
          start_at: start,
          // In-app deep link (the `href` convention the notification lists and push use):
          // the student's lesson page lists their appointments and the join link.
          href:
            recipient === student ? `/student/lessons/${session.lesson_id}` : '/teacher/lessons',
        },
        emailText: `${copy.message}\nTime: ${start}${meetingLine}`,
      });
    }
  }

  /**
   * Shared insert-then-email primitive behind all three Phase 8 meeting
   * notifications plus the pre-existing booking-lifecycle ones: `orIgnore` on
   * the dedupe key makes the in-app row the durable exactly-once gate, and
   * email is best-effort on top of it (never rolls back the caller).
   */
  private async insertAndEmailNotification(params: {
    dedupeKey: string;
    recipient: Pick<User, 'id' | 'email' | 'name'>;
    sourceEvent: string;
    title: string;
    message: string;
    data: Record<string, unknown>;
    emailText?: string;
  }): Promise<void> {
    const insert = await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(Notification)
      .values({
        dedupe_key: params.dedupeKey,
        origin: NotificationOrigin.SYSTEM,
        source_event: params.sourceEvent.slice(0, 120),
        user_id: params.recipient.id,
        type: NotificationType.CUSTOM,
        title: params.title,
        message: params.message,
        // TypeORM's `QueryDeepPartialEntity` mapped type can't express an
        // index-signature JSON column through a shared helper's parameter
        // type (only inline object literals infer cleanly) — same cast
        // precedent as `seed-staging.ts`'s TypeORM assignment workarounds.
        data: params.data as never,
        is_read: false,
        sent_at: new Date(),
        read_at: null,
        sms_sent: false,
        sms_to: null,
        status: NotificationStatus.SENT,
        attempts: 0,
        error_message: null,
        delivered_at: null,
      })
      .orIgnore()
      .returning('id')
      .execute();
    if (insert.identifiers.length === 0 || !params.recipient.email) return;
    const notificationId = insert.identifiers[0]?.['id'] as string | undefined;
    // Enforces `email_enabled` before the email provider is touched, and records the
    // outcome (sent / skipped_preference / failed) against the notification
    // row inserted just above. Never throws — the persisted in-app
    // notification remains the durable delivery record.
    await this.notificationEmail.send({
      userId: params.recipient.id,
      ...(notificationId === undefined ? {} : { notificationId }),
      to: params.recipient.email,
      recipientName: params.recipient.name,
      subject: params.title,
      text: params.emailText ?? params.message,
    });
  }

  /**
   * Phase 8, notification 1 of 2 new ones (the third, `meeting_link_updated`,
   * already existed). Fires on every failed provisioning attempt — the
   * dedupe key is scoped by `meeting_attempts` so a retried Generate that
   * also fails notifies again, while a hypothetical double-execution of the
   * *same* attempt is collapsed by `orIgnore`.
   */
  public async notifyMeetingCreationFailed(session: ScheduledLessonSession): Promise<void> {
    const teacher = await this.dataSource
      .getRepository(User)
      .findOne({ where: { id: session.teacher_id } });
    if (!teacher) return;
    const arabic = teacher.preferred_language === 'ar';
    const start = session.start_at.toISOString();
    const lessonTitle = session.lesson?.title ?? '';
    const reason = session.meeting_error ? `: ${session.meeting_error}` : '';
    const copy = arabic
      ? {
          title: 'فشل إنشاء رابط الاجتماع',
          message: `فشل إنشاء اجتماع ${lessonTitle} في ${start}${reason}. يمكنك إعادة المحاولة.`,
        }
      : {
          title: 'Meeting link creation failed',
          message: `Creating the meeting for ${lessonTitle} at ${start} failed${reason}. You can retry.`,
        };
    await this.insertAndEmailNotification({
      dedupeKey: `lesson-session:${session.id}:meeting_failed:${session.meeting_attempts}`,
      recipient: teacher,
      sourceEvent: 'lesson_session_meeting_creation_failed',
      title: copy.title,
      message: copy.message,
      data: {
        scheduled_lesson_session_id: session.id,
        lesson_id: session.lesson_id,
        event: 'meeting_creation_failed',
        attempt: session.meeting_attempts,
        href: '/teacher/lessons',
      },
    });
  }

  /**
   * Phase 8, notification 2 of 2 new ones. Fires when `getUsableAccount`
   * transitions a connected account to EXPIRED/REVOKED while servicing a
   * provisioning attempt. Bucketed by day rather than by attempt — a broken
   * account can be hit by several provisioning attempts in a short window,
   * and this should notify once, then again only if the problem is still
   * unresolved a day later, not once per attempt (contrast
   * `notifyMeetingCreationFailed` above, which is intentionally per-attempt).
   */
  public async notifyMeetingAccountExpired(account: TeacherMeetingAccount): Promise<void> {
    const teacher = await this.dataSource
      .getRepository(User)
      .findOne({ where: { id: account.teacher_id } });
    if (!teacher) return;
    const arabic = teacher.preferred_language === 'ar';
    const copy = arabic
      ? {
          title: 'يجب إعادة ربط حساب الاجتماعات',
          message: `توقف اتصال حساب ${account.provider} الخاص بك. أعد الربط من صفحة التكاملات لمتابعة إنشاء الاجتماعات.`,
        }
      : {
          title: 'Reconnect your meeting account',
          message: `Your ${account.provider} connection stopped working. Reconnect it from the integrations page to keep generating meetings.`,
        };
    const dayBucket = new Date().toISOString().slice(0, 10);
    await this.insertAndEmailNotification({
      dedupeKey: `meeting-account:${account.id}:expired:${dayBucket}`,
      recipient: teacher,
      sourceEvent: 'meeting_account_expired',
      title: copy.title,
      message: copy.message,
      data: {
        meeting_account_id: account.id,
        provider: account.provider,
        event: 'meeting_account_expired',
        href: '/teacher/integrations',
      },
    });
  }

  private notificationCopy(
    event:
      | 'confirmed'
      | 'reminder_24h'
      | 'reminder_1h'
      | 'meeting_link_updated'
      | 'cancellation_pending'
      | 'cancelled',
    lessonTitle: string,
    start: string,
    arabic: boolean,
  ): { title: string; message: string } {
    if (event === 'confirmed') {
      return arabic
        ? { title: 'تم تأكيد الموعد الفردي', message: `تم تأكيد ${lessonTitle} في ${start}.` }
        : {
            title: 'One-to-one appointment confirmed',
            message: `${lessonTitle} is confirmed for ${start}.`,
          };
    }
    if (event === 'reminder_24h') {
      return arabic
        ? { title: 'تذكير بالموعد', message: `يبدأ ${lessonTitle} خلال نحو 24 ساعة.` }
        : { title: 'Appointment reminder', message: `${lessonTitle} starts in about 24 hours.` };
    }
    if (event === 'reminder_1h') {
      return arabic
        ? { title: 'تذكير بالموعد', message: `يبدأ ${lessonTitle} خلال نحو ساعة.` }
        : { title: 'Appointment reminder', message: `${lessonTitle} starts in about one hour.` };
    }
    if (event === 'meeting_link_updated') {
      return arabic
        ? {
            title: 'تم تحديث رابط الاجتماع',
            message: `تم تحديث رابط اجتماع ${lessonTitle} في ${start}.`,
          }
        : {
            title: 'Meeting link updated',
            message: `The meeting link for ${lessonTitle} at ${start} was updated.`,
          };
    }
    if (event === 'cancelled') {
      return arabic
        ? { title: 'تم إلغاء الموعد', message: `تم إلغاء ${lessonTitle} في ${start} ورد المبلغ.` }
        : {
            title: 'Appointment cancelled',
            message: `${lessonTitle} at ${start} was cancelled and refunded.`,
          };
    }
    return arabic
      ? {
          title: 'طُلب إلغاء الموعد',
          message: `طُلب إلغاء ${lessonTitle} في ${start}. يظل الموعد محجوزًا أثناء مراجعة الاسترداد.`,
        }
      : {
          title: 'Appointment cancellation requested',
          message: `Cancellation was requested for ${lessonTitle} at ${start}. The appointment remains reserved while the refund is reviewed.`,
        };
  }
}
