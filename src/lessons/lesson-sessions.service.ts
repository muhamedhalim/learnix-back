import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, EntityManager, LessThanOrEqual } from 'typeorm';

import { retryTransaction } from '../common/utils/transaction-retry.util';
import { biBody } from '../i18n/error-translator.util';
import { MailService } from '../mail/mail.service';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationStatus } from '../notifications/entities/notification-status.enum';
import { NotificationType } from '../notifications/entities/notification-type.enum';
import { ItemType, Order, Payment } from '../payments/entities';
import { User } from '../users/entities/user.entity';
import { EGP_CURRENCY, toMinorUnits } from '../payments/money.util';
import {
  CancelLessonSessionDto,
  CreateLessonSessionSlotDto,
  UpdateLessonSessionDto,
} from './dto';
import { Lesson } from './entities/lesson.entity';
import {
  ACTIVE_LESSON_SESSION_BOOKING_STATUSES,
  LessonSessionBookingStatus,
} from './entities/lesson-session-booking-status.enum';
import { LessonSessionBooking } from './entities/lesson-session-booking.entity';
import { ScheduledLessonSessionStatus } from './entities/scheduled-lesson-session-status.enum';
import { ScheduledLessonSession } from './entities/scheduled-lesson-session.entity';

interface DatabaseError {
  code?: string;
}

@Injectable()
export class LessonSessionsService {
  private readonly holdMinutes: number;
  private readonly cutoffMinutes: number;

  public constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
    private readonly mailService: MailService,
  ) {
    this.holdMinutes = Math.max(
      1,
      Number.parseInt(config.get<string>('LESSON_SESSION_HOLD_MINUTES') ?? '10', 10),
    );
    this.cutoffMinutes = Math.max(
      0,
      Number.parseInt(config.get<string>('LESSON_SESSION_BOOKING_CUTOFF_MINUTES') ?? '60', 10),
    );
  }

  public async createMany(
    lessonId: string,
    teacherId: string,
    slots: CreateLessonSessionSlotDto[],
  ): Promise<ScheduledLessonSession[]> {
    if (slots.length === 0) return [];
    return await retryTransaction(this.dataSource, async (manager) => {
      const lesson = await this.lockOwnedIndividualLesson(manager, lessonId, teacherId);
      return await this.createManyWithManager(manager, lesson, teacherId, slots);
    });
  }

  /** Used by lesson creation so parent and initial slots commit atomically. */
  public async createManyWithManager(
    manager: EntityManager,
    lesson: Lesson,
    teacherId: string,
    slots: CreateLessonSessionSlotDto[],
  ): Promise<ScheduledLessonSession[]> {
    if (lesson.is_group || lesson.teacher_id !== teacherId) {
      throw new BadRequestException(
        biBody('Only an owned Individual lesson can have appointments', 'يمكن إضافة المواعيد إلى درس فردي مملوك فقط'),
      );
    }
    await this.lockTeacherCalendar(manager, teacherId);
    const sessions: ScheduledLessonSession[] = [];
    for (const slot of slots) {
      const times = this.parseTimes(slot, lesson.duration);
      await this.assertNoTeacherOverlap(manager, teacherId, times.startAt, times.endAt);
      sessions.push(
        await manager.save(
          ScheduledLessonSession,
          manager.create(ScheduledLessonSession, {
            lesson_id: lesson.id,
            teacher_id: teacherId,
            start_at: times.startAt,
            end_at: times.endAt,
            status: ScheduledLessonSessionStatus.SCHEDULED,
            meeting_url: slot.meeting_url?.trim() || null,
            cancellation_reason: null,
            cancellation_requested_at: null,
            cancelled_at: null,
          }),
        ),
      );
    }
    return sessions;
  }

  public async listPublic(lessonId: string): Promise<Array<Record<string, unknown>>> {
    const cutoff = new Date(Date.now() + this.cutoffMinutes * 60_000);
    const sessions = await this.dataSource
      .getRepository(ScheduledLessonSession)
      .createQueryBuilder('session')
      .innerJoin('session.lesson', 'lesson')
      .where('session.lesson_id = :lessonId', { lessonId })
      .andWhere('lesson.is_group = false')
      .andWhere('session.status = :status', { status: ScheduledLessonSessionStatus.SCHEDULED })
      .andWhere('session.start_at > :cutoff', { cutoff })
      .andWhere('session.meeting_url IS NOT NULL')
      .andWhere(`NOT EXISTS (
        SELECT 1 FROM lesson_session_bookings booking
        WHERE booking.scheduled_session_id = session.id
          AND (
            booking.status IN ('payment_review', 'confirmed')
            OR (booking.status = 'held' AND booking.hold_expires_at > NOW())
          )
      )`)
      .orderBy('session.start_at', 'ASC')
      .getMany();
    return sessions.map((session) => this.toSafeSession(session));
  }

  public async reserve(sessionId: string, studentId: string): Promise<Record<string, unknown>> {
    try {
      return await retryTransaction(this.dataSource, async (manager) => {
        const session = await manager.findOne(ScheduledLessonSession, {
          where: { id: sessionId },
          lock: { mode: 'pessimistic_write' },
        });
        const lesson = session
          ? await manager.findOne(Lesson, { where: { id: session.lesson_id } })
          : null;
        if (!session || !lesson || lesson.is_group) {
          throw new NotFoundException(biBody('Appointment not found', 'الموعد غير موجود'));
        }
        session.lesson = lesson;
        this.assertBookable(session);
        const now = new Date();
        await manager.update(
          LessonSessionBooking,
          {
            scheduled_session_id: session.id,
            status: LessonSessionBookingStatus.HELD,
            hold_expires_at: LessThanOrEqual(now),
          },
          { status: LessonSessionBookingStatus.EXPIRED, expired_at: now },
        );
        const active = await manager
          .getRepository(LessonSessionBooking)
          .createQueryBuilder('booking')
          .where('booking.scheduled_session_id = :sessionId', { sessionId: session.id })
          .andWhere('booking.status IN (:...statuses)', {
            statuses: ACTIVE_LESSON_SESSION_BOOKING_STATUSES,
          })
          .getOne();
        if (active) {
          if (
            active.student_id === studentId &&
            active.status === LessonSessionBookingStatus.HELD &&
            active.hold_expires_at > now
          ) {
            return this.toStudentBooking(active, session);
          }
          throw this.unavailable();
        }
        const cutoffAt = this.cutoffAt(session.start_at);
        const holdExpiresAt = new Date(
          Math.min(now.getTime() + this.holdMinutes * 60_000, cutoffAt.getTime()),
        );
        const booking = await manager.save(
          LessonSessionBooking,
          manager.create(LessonSessionBooking, {
            scheduled_session_id: session.id,
            student_id: studentId,
            order_id: null,
            payment_id: null,
            status: LessonSessionBookingStatus.HELD,
            hold_expires_at: holdExpiresAt,
            price_minor_snapshot: toMinorUnits(Number(session.lesson.price)),
            currency: EGP_CURRENCY,
            confirmed_at: null,
            expired_at: null,
            failed_at: null,
            cancelled_at: null,
            refunded_at: null,
          }),
        );
        return this.toStudentBooking(booking, session);
      });
    } catch (error: unknown) {
      if ((error as DatabaseError).code === '23505') throw this.unavailable();
      throw error;
    }
  }

  public async release(bookingId: string, studentId: string): Promise<void> {
    await retryTransaction(this.dataSource, async (manager) => {
      const booking = await manager.findOne(LessonSessionBooking, {
        where: { id: bookingId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!booking || booking.student_id !== studentId) {
        throw new NotFoundException(biBody('Booking not found', 'الحجز غير موجود'));
      }
      if (booking.order_id || booking.status !== LessonSessionBookingStatus.HELD) {
        throw new ConflictException(
          biBody('This booking can no longer be released', 'لا يمكن إلغاء هذا الحجز الآن'),
        );
      }
      booking.status = LessonSessionBookingStatus.CANCELLED;
      booking.cancelled_at = new Date();
      await manager.save(booking);
    });
  }

  public async expireStaleHolds(): Promise<number> {
    const now = new Date();
    const result = await this.dataSource.getRepository(LessonSessionBooking).update(
      {
        status: LessonSessionBookingStatus.HELD,
        hold_expires_at: LessThanOrEqual(now),
      },
      { status: LessonSessionBookingStatus.EXPIRED, expired_at: now },
    );
    await this.dataSource.getRepository(ScheduledLessonSession).update(
      {
        status: ScheduledLessonSessionStatus.SCHEDULED,
        end_at: LessThanOrEqual(now),
      },
      { status: ScheduledLessonSessionStatus.COMPLETED },
    );
    return result.affected ?? 0;
  }

  public async listForStudent(studentId: string): Promise<Array<Record<string, unknown>>> {
    const bookings = await this.dataSource.getRepository(LessonSessionBooking).find({
      where: { student_id: studentId },
      relations: ['session', 'session.lesson', 'session.teacher', 'order', 'payment'],
      order: { created_at: 'DESC' },
    });
    return bookings.map((booking) => this.toStudentBooking(booking, booking.session));
  }

  public async listForTeacher(
    lessonId: string,
    teacherId: string,
  ): Promise<Array<Record<string, unknown>>> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const sessions = await this.dataSource.getRepository(ScheduledLessonSession).find({
      where: { lesson_id: lessonId, teacher_id: teacherId },
      relations: ['bookings', 'bookings.student', 'bookings.order', 'bookings.payment'],
      order: { start_at: 'ASC' },
    });
    return sessions.map((session) => this.toPrivilegedSession(session));
  }

  public async listForAdmin(lessonId: string): Promise<Array<Record<string, unknown>>> {
    const sessions = await this.dataSource.getRepository(ScheduledLessonSession).find({
      where: { lesson_id: lessonId },
      relations: ['teacher', 'bookings', 'bookings.student', 'bookings.order', 'bookings.payment'],
      order: { start_at: 'ASC' },
    });
    return sessions.map((session) => this.toPrivilegedSession(session));
  }

  public async update(
    lessonId: string,
    sessionId: string,
    teacherId: string,
    dto: UpdateLessonSessionDto,
  ): Promise<Record<string, unknown>> {
    let meetingLinkChangedForBooking: string | null = null;
    const result = await retryTransaction(this.dataSource, async (manager) => {
      const session = await this.lockOwnedSession(manager, lessonId, sessionId, teacherId);
      const active = await this.findActiveBooking(manager, session.id);
      const changesTime = dto.start_at !== undefined || dto.end_at !== undefined;
      if (active && active.status !== LessonSessionBookingStatus.CONFIRMED) throw this.unavailable();
      if (active?.status === LessonSessionBookingStatus.CONFIRMED && changesTime) {
        throw new ConflictException(
          biBody(
            'A confirmed appointment cannot be moved; cancel and create a new slot',
            'لا يمكن نقل موعد مؤكد؛ ألغِه وأنشئ موعدًا جديدًا',
          ),
        );
      }
      if (session.status !== ScheduledLessonSessionStatus.SCHEDULED) throw this.unavailable();
      const startAt = dto.start_at ? new Date(dto.start_at) : session.start_at;
      const endAt = dto.end_at ? new Date(dto.end_at) : session.end_at;
      this.assertTimes(startAt, endAt);
      if (changesTime) {
        await this.lockTeacherCalendar(manager, teacherId);
        await this.assertNoTeacherOverlap(manager, teacherId, startAt, endAt, session.id);
      }
      session.start_at = startAt;
      session.end_at = endAt;
      if (dto.meeting_url !== undefined) {
        const nextUrl = dto.meeting_url.trim();
        if (active?.status === LessonSessionBookingStatus.CONFIRMED && nextUrl !== session.meeting_url) {
          meetingLinkChangedForBooking = active.id;
        }
        session.meeting_url = nextUrl;
      }
      await manager.save(session);
      return this.toPrivilegedSession(session);
    });
    if (meetingLinkChangedForBooking) {
      await this.notifyBookingEvent(meetingLinkChangedForBooking, 'meeting_link_updated');
    }
    return result;
  }

  public async cancel(
    lessonId: string,
    sessionId: string,
    teacherId: string,
    dto: CancelLessonSessionDto,
  ): Promise<Record<string, unknown>> {
    let confirmedBookingId: string | null = null;
    const result = await retryTransaction(this.dataSource, async (manager) => {
      const session = await this.lockOwnedSession(manager, lessonId, sessionId, teacherId);
      const active = await this.findActiveBooking(manager, session.id);
      const now = new Date();
      session.cancellation_reason = dto.reason.trim();
      if (active?.status === LessonSessionBookingStatus.CONFIRMED) {
        confirmedBookingId = active.id;
        session.status = ScheduledLessonSessionStatus.CANCELLATION_PENDING;
        session.cancellation_requested_at = now;
      } else if (active) {
        throw new ConflictException(
          biBody('Checkout is in progress for this slot', 'توجد عملية دفع جارية لهذا الموعد'),
        );
      } else {
        session.status = ScheduledLessonSessionStatus.CANCELLED;
        session.cancelled_at = now;
      }
      await manager.save(session);
      return this.toPrivilegedSession(session);
    });
    if (confirmedBookingId) await this.notifyBookingEvent(confirmedBookingId, 'cancellation_pending');
    return result;
  }

  public async getCheckoutProduct(sessionId: string, manager?: EntityManager): Promise<{
    session: ScheduledLessonSession;
    lesson: Lesson;
  }> {
    const repository = (manager ?? this.dataSource.manager).getRepository(ScheduledLessonSession);
    const session = await repository.findOne({ where: { id: sessionId }, relations: ['lesson'] });
    if (!session || session.lesson.is_group) {
      throw new NotFoundException(biBody('Appointment not found', 'الموعد غير موجود'));
    }
    return { session, lesson: session.lesson };
  }

  public async assertCheckoutReservation(
    bookingId: string | undefined,
    studentId: string,
    sessionId: string,
  ): Promise<LessonSessionBooking> {
    if (!bookingId) throw this.unavailable();
    const booking = await this.dataSource.getRepository(LessonSessionBooking).findOne({
      where: { id: bookingId, student_id: studentId, scheduled_session_id: sessionId },
    });
    if (
      !booking ||
      booking.status !== LessonSessionBookingStatus.HELD ||
      booking.hold_expires_at <= new Date()
    ) {
      throw this.unavailable();
    }
    return booking;
  }

  public canPaymentWindowFit(startAt: Date, expirationMinutes: number, now = new Date()): boolean {
    return now.getTime() + expirationMinutes * 60_000 <= this.cutoffAt(startAt).getTime();
  }

  public async attachOrder(
    manager: EntityManager,
    bookingId: string,
    studentId: string,
    order: Order,
    payment: Payment,
    requestedExpiry: Date,
  ): Promise<void> {
    const booking = await manager.findOne(LessonSessionBooking, {
      where: { id: bookingId },
      lock: { mode: 'pessimistic_write' },
    });
    const session = booking
      ? await manager.findOne(ScheduledLessonSession, { where: { id: booking.scheduled_session_id } })
      : null;
    const now = new Date();
    if (
      !booking ||
      booking.student_id !== studentId ||
      booking.scheduled_session_id !== order.item_id ||
      booking.status !== LessonSessionBookingStatus.HELD ||
      booking.order_id !== null ||
      booking.hold_expires_at <= now ||
      !session
    ) {
      throw this.unavailable();
    }
    const cutoff = this.cutoffAt(session.start_at);
    if (requestedExpiry > cutoff) {
      throw new BadRequestException(
        biBody(
          'This payment method cannot complete before the booking cutoff',
          'لا يمكن إتمام طريقة الدفع هذه قبل موعد إغلاق الحجز',
        ),
      );
    }
    booking.order_id = order.id;
    booking.payment_id = payment.id;
    booking.hold_expires_at = requestedExpiry;
    await manager.save(booking);
  }

  public async confirmForOrder(
    manager: EntityManager,
    order: Order,
    payment: Payment,
  ): Promise<LessonSessionBooking | null> {
    if (order.item_type !== ItemType.LESSON_SESSION) return null;
    const booking = await manager.findOne(LessonSessionBooking, {
      where: { order_id: order.id },
      lock: { mode: 'pessimistic_write' },
    });
    const session = booking
      ? await manager.findOne(ScheduledLessonSession, { where: { id: booking.scheduled_session_id } })
      : null;
    const lesson = session ? await manager.findOne(Lesson, { where: { id: session.lesson_id } }) : null;
    if (
      !booking ||
      !session ||
      !lesson ||
      booking.payment_id !== payment.id ||
      booking.student_id !== order.student_id ||
      booking.scheduled_session_id !== order.item_id ||
      booking.price_minor_snapshot !== order.original_amount_minor ||
      booking.currency !== order.currency ||
      session.status !== ScheduledLessonSessionStatus.SCHEDULED ||
      session.start_at <= new Date() ||
      ![
        LessonSessionBookingStatus.HELD,
        LessonSessionBookingStatus.PAYMENT_REVIEW,
        LessonSessionBookingStatus.CONFIRMED,
      ].includes(booking.status)
    ) {
      throw this.unavailable();
    }
    if (booking.status !== LessonSessionBookingStatus.CONFIRMED) {
      booking.status = LessonSessionBookingStatus.CONFIRMED;
      booking.confirmed_at = new Date();
      await manager.save(booking);
    }
    booking.session = session;
    booking.session.lesson = lesson;
    return booking;
  }

  public async markForOrder(
    manager: EntityManager,
    orderId: string,
    status: LessonSessionBookingStatus,
  ): Promise<void> {
    const booking = await manager.findOne(LessonSessionBooking, {
      where: { order_id: orderId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!booking || booking.status === LessonSessionBookingStatus.CONFIRMED) return;
    booking.status = status;
    const now = new Date();
    if (status === LessonSessionBookingStatus.EXPIRED) booking.expired_at = now;
    if (status === LessonSessionBookingStatus.FAILED) booking.failed_at = now;
    if (status === LessonSessionBookingStatus.CANCELLED) booking.cancelled_at = now;
    await manager.save(booking);
  }

  public async refundForOrder(manager: EntityManager, orderId: string): Promise<void> {
    const booking = await manager.findOne(LessonSessionBooking, {
      where: { order_id: orderId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!booking) return;
    const session = await manager.findOne(ScheduledLessonSession, {
      where: { id: booking.scheduled_session_id },
    });
    if (!session) return;
    booking.status = LessonSessionBookingStatus.REFUNDED;
    booking.refunded_at = new Date();
    await manager.save(booking);
    if (session.status === ScheduledLessonSessionStatus.CANCELLATION_PENDING) {
      session.status = ScheduledLessonSessionStatus.CANCELLED;
      session.cancelled_at = new Date();
      await manager.save(session);
    }
  }

  /**
   * Confirmation and reminder delivery is deliberately commit-observing: the
   * job only sees rows after their financial transaction has committed. The
   * notification dedupe key is the durable exactly-once gate for each event.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  public async dispatchScheduledSessionNotifications(): Promise<void> {
    const now = new Date();
    const reminderHorizon = new Date(now.getTime() + 24 * 60 * 60_000);
    const bookings = await this.dataSource
      .getRepository(LessonSessionBooking)
      .createQueryBuilder('booking')
      .innerJoinAndSelect('booking.session', 'session')
      .innerJoinAndSelect('session.lesson', 'lesson')
      .innerJoinAndSelect('session.teacher', 'teacher')
      .innerJoinAndSelect('booking.student', 'student')
      .where('booking.status = :status', { status: LessonSessionBookingStatus.CONFIRMED })
      .andWhere(`(
        NOT EXISTS (
          SELECT 1 FROM notifications notification
          WHERE notification.dedupe_key = CONCAT(
            'lesson-session:', session.id, ':booking:', booking.id, ':confirmed:', booking.student_id
          )
        )
        OR NOT EXISTS (
          SELECT 1 FROM notifications notification
          WHERE notification.dedupe_key = CONCAT(
            'lesson-session:', session.id, ':booking:', booking.id, ':confirmed:', session.teacher_id
          )
        )
        OR (session.start_at > :now AND session.start_at <= :horizon)
      )`, { now, horizon: reminderHorizon })
      .getMany();
    for (const booking of bookings) {
      await this.notifyBookingEvent(booking.id, 'confirmed', booking);
      const untilStart = booking.session.start_at.getTime() - now.getTime();
      if (untilStart > 0 && untilStart <= 24 * 60 * 60_000 && untilStart > 23 * 60 * 60_000) {
        await this.notifyBookingEvent(booking.id, 'reminder_24h', booking);
      }
      if (untilStart > 0 && untilStart <= 60 * 60_000 && untilStart > 50 * 60_000) {
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
      .andWhere('session.status = :sessionStatus', { sessionStatus: ScheduledLessonSessionStatus.CANCELLED })
      .andWhere(`(
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
      )`)
      .getMany();
    for (const booking of cancelledBookings) {
      await this.notifyBookingEvent(booking.id, 'cancelled', booking);
    }
  }

  private async notifyBookingEvent(
    bookingId: string,
    event: 'confirmed' | 'reminder_24h' | 'reminder_1h' | 'meeting_link_updated' | 'cancellation_pending' | 'cancelled',
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
      if (event === 'cancellation_pending' && current?.session.status !== ScheduledLessonSessionStatus.CANCELLATION_PENDING) {
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
      const dedupeKey = `lesson-session:${session.id}:booking:${booking.id}:${event}:${recipient.id}`;
      const insert = await this.dataSource
        .createQueryBuilder()
        .insert()
        .into(Notification)
        .values({
          dedupe_key: dedupeKey,
          user_id: recipient.id,
          type: NotificationType.CUSTOM,
          title: copy.title,
          message: copy.message,
          data: {
            scheduled_lesson_session_id: session.id,
            lesson_id: session.lesson_id,
            booking_id: booking.id,
            event,
            start_at: start,
          },
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
      if (insert.identifiers.length === 0 || !recipient.email) continue;
      const meetingLine =
        recipient.id === teacher.id || booking.status === LessonSessionBookingStatus.CONFIRMED
          ? `\n${arabic ? 'رابط الاجتماع' : 'Meeting'}: ${session.meeting_url ?? (arabic ? 'غير محدد' : 'Not set')}`
          : '';
      try {
        await this.mailService.send({
          to: recipient.email,
          recipientName: recipient.name,
          subject: copy.title,
          text: `${copy.message}\nTime: ${start}${meetingLine}`,
        });
      } catch {
        // The persisted in-app notification remains the durable delivery record.
        // Mail delivery is intentionally best-effort and must not roll back a booking action.
      }
    }
  }

  private notificationCopy(
    event: 'confirmed' | 'reminder_24h' | 'reminder_1h' | 'meeting_link_updated' | 'cancellation_pending' | 'cancelled',
    lessonTitle: string,
    start: string,
    arabic: boolean,
  ): { title: string; message: string } {
    if (event === 'confirmed') {
      return arabic
        ? { title: 'تم تأكيد الموعد الفردي', message: `تم تأكيد ${lessonTitle} في ${start}.` }
        : { title: 'One-to-one appointment confirmed', message: `${lessonTitle} is confirmed for ${start}.` };
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
        ? { title: 'تم تحديث رابط الاجتماع', message: `تم تحديث رابط اجتماع ${lessonTitle} في ${start}.` }
        : { title: 'Meeting link updated', message: `The meeting link for ${lessonTitle} at ${start} was updated.` };
    }
    if (event === 'cancelled') {
      return arabic
        ? { title: 'تم إلغاء الموعد', message: `تم إلغاء ${lessonTitle} في ${start} ورد المبلغ.` }
        : { title: 'Appointment cancelled', message: `${lessonTitle} at ${start} was cancelled and refunded.` };
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

  private parseTimes(
    slot: CreateLessonSessionSlotDto,
    lessonDuration: number | null,
  ): { startAt: Date; endAt: Date } {
    const startAt = new Date(slot.start_at);
    const endAt = slot.end_at
      ? new Date(slot.end_at)
      : new Date(startAt.getTime() + (lessonDuration ?? 0) * 1000);
    this.assertTimes(startAt, endAt);
    return { startAt, endAt };
  }

  private assertTimes(startAt: Date, endAt: Date): void {
    if (
      !Number.isFinite(startAt.getTime()) ||
      !Number.isFinite(endAt.getTime()) ||
      endAt <= startAt ||
      startAt <= new Date()
    ) {
      throw new BadRequestException(
        biBody('Session times must define a valid future interval', 'يجب أن تحدد أوقات الجلسة فترة صحيحة في المستقبل'),
      );
    }
  }

  private assertBookable(session: ScheduledLessonSession): void {
    if (
      session.status !== ScheduledLessonSessionStatus.SCHEDULED ||
      !session.meeting_url ||
      session.start_at <= new Date(Date.now() + this.cutoffMinutes * 60_000)
    ) {
      throw this.unavailable();
    }
  }

  private async lockOwnedIndividualLesson(
    manager: EntityManager,
    lessonId: string,
    teacherId: string,
  ): Promise<Lesson> {
    const lesson = await manager.findOne(Lesson, {
      where: { id: lessonId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!lesson || lesson.teacher_id !== teacherId) throw new ForbiddenException();
    if (lesson.is_group) {
      throw new BadRequestException(
        biBody('Group lessons cannot have appointments', 'لا يمكن إضافة مواعيد للدروس الجماعية'),
      );
    }
    if (!lesson.duration || lesson.duration <= 0) {
      throw new BadRequestException(
        biBody('Individual lessons require a session duration', 'الدروس الفردية تتطلب مدة للجلسة'),
      );
    }
    return lesson;
  }

  private async assertOwnedLesson(lessonId: string, teacherId: string): Promise<void> {
    const lesson = await this.dataSource.getRepository(Lesson).findOne({ where: { id: lessonId } });
    if (!lesson || lesson.teacher_id !== teacherId) throw new ForbiddenException();
  }

  private async lockOwnedSession(
    manager: EntityManager,
    lessonId: string,
    sessionId: string,
    teacherId: string,
  ): Promise<ScheduledLessonSession> {
    const session = await manager.findOne(ScheduledLessonSession, {
      where: { id: sessionId, lesson_id: lessonId, teacher_id: teacherId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!session) throw new ForbiddenException();
    return session;
  }

  private async lockTeacherCalendar(manager: EntityManager, teacherId: string): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [teacherId]);
  }

  private async assertNoTeacherOverlap(
    manager: EntityManager,
    teacherId: string,
    startAt: Date,
    endAt: Date,
    excludeId?: string,
  ): Promise<void> {
    const query = manager
      .getRepository(ScheduledLessonSession)
      .createQueryBuilder('session')
      .where('session.teacher_id = :teacherId', { teacherId })
      .andWhere('session.status IN (:...statuses)', {
        statuses: [
          ScheduledLessonSessionStatus.SCHEDULED,
          ScheduledLessonSessionStatus.CANCELLATION_PENDING,
        ],
      })
      .andWhere('session.start_at < :endAt AND session.end_at > :startAt', { startAt, endAt });
    if (excludeId) query.andWhere('session.id <> :excludeId', { excludeId });
    if (await query.getExists()) {
      throw new ConflictException(
        biBody('This appointment overlaps another teacher appointment', 'يتداخل هذا الموعد مع موعد آخر للمعلم'),
      );
    }
  }

  private async findActiveBooking(
    manager: EntityManager,
    sessionId: string,
  ): Promise<LessonSessionBooking | null> {
    return await manager
      .getRepository(LessonSessionBooking)
      .createQueryBuilder('booking')
      .where('booking.scheduled_session_id = :sessionId', { sessionId })
      .andWhere('booking.status IN (:...statuses)', {
        statuses: ACTIVE_LESSON_SESSION_BOOKING_STATUSES,
      })
      .getOne();
  }

  private cutoffAt(startAt: Date): Date {
    return new Date(startAt.getTime() - this.cutoffMinutes * 60_000);
  }

  private unavailable(): ConflictException {
    return new ConflictException(
      biBody('This appointment is no longer available', 'هذا الموعد لم يعد متاحًا'),
    );
  }

  private toSafeSession(session: ScheduledLessonSession): Record<string, unknown> {
    return {
      id: session.id,
      lesson_id: session.lesson_id,
      start_at: session.start_at,
      end_at: session.end_at,
      duration_seconds: Math.round((session.end_at.getTime() - session.start_at.getTime()) / 1000),
      availability: 'available',
    };
  }

  private toStudentBooking(
    booking: LessonSessionBooking,
    session: ScheduledLessonSession,
  ): Record<string, unknown> {
    const lesson = session.lesson;
    const teacher = session.teacher;
    return {
      id: booking.id,
      status: booking.status,
      hold_expires_at: booking.hold_expires_at,
      price_minor: booking.price_minor_snapshot,
      currency: booking.currency,
      order_id: booking.order_id,
      payment_id: booking.payment_id,
      session: {
        id: session.id,
        start_at: session.start_at,
        end_at: session.end_at,
        status: session.status,
        meeting_url:
          booking.status === LessonSessionBookingStatus.CONFIRMED ? session.meeting_url : null,
      },
      lesson: lesson
        ? { id: lesson.id, title: lesson.title, duration: lesson.duration, teacher_id: lesson.teacher_id }
        : undefined,
      teacher: teacher ? { id: teacher.id, name: teacher.name } : undefined,
    };
  }

  private toPrivilegedSession(session: ScheduledLessonSession): Record<string, unknown> {
    const booking = session.bookings?.find((candidate) =>
      (ACTIVE_LESSON_SESSION_BOOKING_STATUSES as readonly LessonSessionBookingStatus[]).includes(
        candidate.status,
      ),
    );
    const bookingHistory = [...(session.bookings ?? [])]
      .sort((left, right) => right.created_at.getTime() - left.created_at.getTime())
      .map((candidate) => this.toPrivilegedBooking(candidate));
    return {
      ...this.toSafeSession(session),
      availability:
        !booking &&
        session.status === ScheduledLessonSessionStatus.SCHEDULED &&
        /^https:\/\//i.test(session.meeting_url ?? '') &&
        this.cutoffAt(session.start_at) > new Date()
          ? 'available'
          : 'unavailable',
      status: session.status,
      meeting_url: session.meeting_url,
      cancellation_reason: session.cancellation_reason,
      booking: booking ? this.toPrivilegedBooking(booking) : null,
      booking_history: bookingHistory,
    };
  }

  private toPrivilegedBooking(booking: LessonSessionBooking): Record<string, unknown> {
    const mayShowStudent = [
      LessonSessionBookingStatus.CONFIRMED,
      LessonSessionBookingStatus.CANCELLED,
      LessonSessionBookingStatus.REFUNDED,
    ].includes(booking.status);
    return {
      id: booking.id,
      status: booking.status,
      created_at: booking.created_at,
      student:
        mayShowStudent && booking.student ? { id: booking.student.id, name: booking.student.name } : null,
      order: booking.order
        ? { id: booking.order.id, number: booking.order.order_number, status: booking.order.status }
        : null,
      payment: booking.payment
        ? { id: booking.payment.id, status: booking.payment.status }
        : null,
    };
  }
}
