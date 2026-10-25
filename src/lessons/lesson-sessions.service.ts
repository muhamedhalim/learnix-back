import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { Queue } from 'bullmq';
import { DataSource, EntityManager, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';

import { resolveAppTimeZone } from '../common/utils/app-timezone.util';
import { retryTransaction } from '../common/utils/transaction-retry.util';
import { biBody } from '../i18n/error-translator.util';
import { NotificationEmailService } from '../notifications/services/notification-email.service';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationOrigin } from '../notifications/entities/notification-origin.enum';
import { NotificationStatus } from '../notifications/entities/notification-status.enum';
import { NotificationType } from '../notifications/entities/notification-type.enum';
import { ItemType, Order, Payment } from '../payments/entities';
import { JOB_TYPES, QUEUE_NAMES } from '../queues/queues.constants';
import { queueJobId } from '../queues/job-id.util';
import { NoopQueue } from '../queues/noop-queue';
import { User } from '../users/entities/user.entity';
import { EGP_CURRENCY, toMinorUnits } from '../payments/money.util';
import { CancelLessonSessionDto, CreateLessonSessionSlotDto, UpdateLessonSessionDto } from './dto';
import { Lesson } from './entities/lesson.entity';
import {
  ACTIVE_LESSON_SESSION_BOOKING_STATUSES,
  LessonSessionBookingStatus,
} from './entities/lesson-session-booking-status.enum';
import { LessonSessionBooking } from './entities/lesson-session-booking.entity';
import { MeetingCreationStatus } from './entities/meeting-creation-status.enum';
import { MeetingProvider } from './entities/meeting-provider.enum';
import { ScheduledLessonSessionStatus } from './entities/scheduled-lesson-session-status.enum';
import { ScheduledLessonSession } from './entities/scheduled-lesson-session.entity';
import { TeacherMeetingAccount } from './entities/teacher-meeting-account.entity';
import { TeacherMeetingAccountStatus } from './entities/teacher-meeting-account-status.enum';
import { MeetingAccountsService } from './meetings/meeting-accounts.service';
import { MeetingProviderRegistry } from './meetings/meeting-provider-registry.service';
import { RetryableProviderError } from './meetings/providers/provider-errors';
import { CronSingleRunner } from '../common/utils/cron-lock.util';

interface DatabaseError {
  code?: string;
}

interface MeetingProvisionJobData {
  sessionId: string;
}

@Injectable()
export class LessonSessionsService {
  private readonly holdMinutes: number;
  private readonly cutoffMinutes: number;
  private readonly meetingProvisioningStuckMinutes: number;

  public constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
    /**
     * Optional notification mail, not raw transport. These session emails
     * merely mirror an in-app notification the user could read in the app, so
     * they are exactly what the "Email notifications" preference is for — and
     * routing them through this service is what makes that toggle real. Nothing
     * here is transactional or security-critical (see `NotificationEmailService`
     * for the enumerated boundary).
     */
    private readonly notificationEmail: NotificationEmailService,
    private readonly meetingProviders: MeetingProviderRegistry,
    private readonly meetingAccounts: MeetingAccountsService,
    @InjectQueue(QUEUE_NAMES.MEETING_PROVISIONING)
    private readonly meetingQueue: Queue<MeetingProvisionJobData>,
  ) {
    this.holdMinutes = Math.max(
      1,
      Number.parseInt(config.get<string>('LESSON_SESSION_HOLD_MINUTES') ?? '10', 10),
    );
    this.cutoffMinutes = Math.max(
      0,
      Number.parseInt(config.get<string>('LESSON_SESSION_BOOKING_CUTOFF_MINUTES') ?? '60', 10),
    );
    this.meetingProvisioningStuckMinutes = Math.max(
      1,
      Number.parseInt(config.get<string>('MEETING_PROVISIONING_STUCK_MINUTES') ?? '15', 10),
    );
  }

  /**
   * Booking cutoff horizon, in minutes, shared with `LessonsService` so the
   * public lesson list's "available appointments" projection uses the exact
   * same bookability horizon as `listPublic` below.
   */
  public getBookingCutoffMinutes(): number {
    return this.cutoffMinutes;
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
        biBody(
          'Only an owned Individual lesson can have appointments',
          'يمكن إضافة المواعيد إلى درس فردي مملوك فقط',
        ),
      );
    }
    await this.lockTeacherCalendar(manager, teacherId);
    const sessions: ScheduledLessonSession[] = [];
    for (const slot of slots) {
      const times = this.parseTimes(slot, lesson.duration);
      await this.assertNoTeacherOverlap(manager, teacherId, times.startAt, times.endAt);
      // AD-7: creating a slot never creates a meeting. A manual URL (AD-10)
      // is immediately `ready`; a selected provider merely records intent —
      // it stays `not_requested` until the teacher explicitly Generates.
      const meetingUrl = slot.meeting_url?.trim() || null;
      const meetingProvider = meetingUrl ? MeetingProvider.MANUAL : (slot.meeting_provider ?? null);
      sessions.push(
        await manager.save(
          ScheduledLessonSession,
          manager.create(ScheduledLessonSession, {
            lesson_id: lesson.id,
            teacher_id: teacherId,
            start_at: times.startAt,
            end_at: times.endAt,
            status: ScheduledLessonSessionStatus.SCHEDULED,
            meeting_url: meetingUrl,
            meeting_provider: meetingProvider,
            meeting_status: meetingUrl
              ? MeetingCreationStatus.READY
              : MeetingCreationStatus.NOT_REQUESTED,
            meeting_ready_at: meetingUrl ? new Date() : null,
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
      .andWhere(
        `NOT EXISTS (
        SELECT 1 FROM lesson_session_bookings booking
        WHERE booking.scheduled_session_id = session.id
          AND (
            booking.status IN ('payment_review', 'confirmed')
            OR (booking.status = 'held' AND booking.hold_expires_at > NOW())
          )
      )`,
      )
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

  /**
   * Phase 8 stuck-`creating` sweep. A worker that crashes between claiming a
   * row (`pending` -> `creating`) and persisting the result leaves it wedged
   * forever — this returns it to `failed` after `meetingProvisioningStuckMinutes`
   * so the teacher can Retry through the ordinary Phase 5 endpoint. The
   * `(meeting_provider, external_meeting_id)` unique index still absorbs any
   * meeting that actually landed at the provider before the crash (R-15).
   * Invoked from `PaymentOperationsService`'s advisory-locked maintenance
   * cycle, the same registration used for `expireStaleHolds`.
   */
  public async sweepStuckMeetingProvisioning(): Promise<number> {
    const cutoff = new Date(Date.now() - this.meetingProvisioningStuckMinutes * 60_000);
    const repository = this.dataSource.getRepository(ScheduledLessonSession);
    const stuck = await repository.find({
      where: [
        {
          meeting_status: MeetingCreationStatus.CREATING,
          meeting_requested_at: LessThanOrEqual(cutoff),
        },
        {
          meeting_status: MeetingCreationStatus.PENDING,
          meeting_requested_at: LessThanOrEqual(cutoff),
        },
      ],
      relations: ['lesson'],
    });
    const giveUpBefore = Date.now() - 2 * this.meetingProvisioningStuckMinutes * 60_000;
    for (const session of stuck) {
      if (session.meeting_status === MeetingCreationStatus.PENDING && session.meeting_requested_at) {
        // A `pending` row whose job never ran (lost enqueue, no worker). Give it
        // one recovery enqueue; the fixed `recover` id keeps repeated sweeps
        // from stacking jobs. Past twice the cutoff, fail it so the teacher
        // can Retry instead of being stuck forever.
        if (session.meeting_requested_at.getTime() > giveUpBefore) {
          await this.meetingQueue
            .add(
              JOB_TYPES.MEETING.PROVISION,
              { sessionId: session.id },
              {
                jobId: queueJobId(
                  'meeting',
                  'provision',
                  session.id,
                  session.meeting_requested_at.getTime(),
                  'recover',
                ),
              },
            )
            .catch(() => undefined);
          continue;
        }
        session.meeting_error = 'Meeting creation did not start';
      } else {
        session.meeting_error = 'Meeting creation timed out';
      }
      session.meeting_status = MeetingCreationStatus.FAILED;
      session.meeting_attempts += 1;
      await repository.save(session).catch(() => undefined);
      await this.notifyMeetingCreationFailed(session).catch(() => undefined);
    }
    return stuck.length;
  }

  public async listForStudent(
    studentId: string,
    lessonId?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const bookings = await this.dataSource.getRepository(LessonSessionBooking).find({
      where: {
        student_id: studentId,
        ...(lessonId === undefined ? {} : { session: { lesson_id: lessonId } }),
      },
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
    let meetingNeedsTimeSync = false;
    const result = await retryTransaction(this.dataSource, async (manager) => {
      const session = await this.lockOwnedSession(manager, lessonId, sessionId, teacherId);
      const active = await this.findActiveBooking(manager, session.id);
      const changesTime = dto.start_at !== undefined || dto.end_at !== undefined;
      if (active && active.status !== LessonSessionBookingStatus.CONFIRMED)
        throw this.unavailable();
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
      meetingNeedsTimeSync =
        changesTime &&
        session.meeting_status === MeetingCreationStatus.READY &&
        !!session.external_meeting_id &&
        !!session.meeting_provider &&
        session.meeting_provider !== MeetingProvider.MANUAL;
      session.start_at = startAt;
      session.end_at = endAt;
      if (dto.meeting_provider !== undefined) {
        // R-17: switching provider while a meeting exists (or is in flight)
        // would orphan it at the old provider — DELETE .../meeting first.
        if (this.hasActiveOrReadyMeeting(session)) {
          throw new ConflictException(
            biBody(
              'Remove the existing meeting before changing the provider',
              'أزل الاجتماع الحالي قبل تغيير المزود',
            ),
          );
        }
        session.meeting_provider = dto.meeting_provider;
      }
      if (dto.meeting_url !== undefined) {
        // The pre-existing manual-URL path (AD-10). Setting it directly is
        // rejected while a real provider-generated meeting is live, for the
        // same reason as above.
        if (this.hasActiveOrReadyMeeting(session)) {
          throw new ConflictException(
            biBody(
              'Remove the existing meeting before setting a manual link',
              'أزل الاجتماع الحالي قبل تعيين رابط يدوي',
            ),
          );
        }
        const nextUrl = dto.meeting_url.trim();
        if (
          active?.status === LessonSessionBookingStatus.CONFIRMED &&
          nextUrl !== session.meeting_url
        ) {
          meetingLinkChangedForBooking = active.id;
        }
        session.meeting_url = nextUrl;
        session.meeting_provider = MeetingProvider.MANUAL;
        session.meeting_status = MeetingCreationStatus.READY;
        session.meeting_ready_at = new Date();
        session.meeting_error = null;
      }
      await manager.save(session);
      return this.toPrivilegedSession(session);
    });
    if (meetingLinkChangedForBooking) {
      await this.notifyBookingEvent(meetingLinkChangedForBooking, 'meeting_link_updated');
    }
    if (meetingNeedsTimeSync) await this.enqueueMeetingTimeSync(sessionId);
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
    if (confirmedBookingId)
      await this.notifyBookingEvent(confirmedBookingId, 'cancellation_pending');
    return result;
  }

  /**
   * `POST /teacher/lessons/:lessonId/sessions/:sessionId/meeting` — the
   * explicit Generate action (AD-7). Enforces the 7 preconditions in order,
   * then commits `pending` before enqueuing exactly one job (AD-9): the row
   * always exists before the provider is ever called.
   */
  public async requestMeetingGeneration(
    lessonId: string,
    sessionId: string,
    teacherId: string,
    provider: MeetingProvider | undefined,
  ): Promise<Record<string, unknown>> {
    let requestedAtMs = 0;
    const session = await retryTransaction(this.dataSource, async (manager) => {
      // 1. Ownership.
      const locked = await this.lockOwnedSession(manager, lessonId, sessionId, teacherId);
      const lesson = await manager.findOne(Lesson, { where: { id: lessonId } });
      if (!lesson) throw new ForbiddenException();
      // 2. Individual lesson only.
      if (lesson.is_group) {
        throw new BadRequestException(
          biBody(
            'Group lessons cannot have meetings',
            'لا يمكن أن تحتوي الدروس الجماعية على اجتماعات',
          ),
        );
      }
      // 3. Valid future scheduled session.
      if (
        locked.status !== ScheduledLessonSessionStatus.SCHEDULED ||
        locked.start_at <= new Date()
      ) {
        throw this.unavailable();
      }
      // 4. Provider selected and configured.
      const resolvedProvider = provider ?? locked.meeting_provider;
      if (!resolvedProvider || resolvedProvider === MeetingProvider.MANUAL) {
        throw new BadRequestException(
          biBody('Select a meeting provider first', 'اختر مزود اجتماعات أولاً'),
        );
      }
      const client = this.meetingProviders.find(resolvedProvider);
      if (!client || !client.isConfigured()) {
        throw new BadRequestException(
          biBody('This meeting provider is not available', 'مزود الاجتماعات هذا غير متاح'),
        );
      }
      // 5. Connected account for that provider.
      const account = await this.meetingAccounts.findConnectedAccount(teacherId, resolvedProvider);
      if (!account) {
        throw new ConflictException({
          ...biBody('Connect this meeting provider first', 'اربط مزود الاجتماعات هذا أولاً'),
          code: 'MEETING_ACCOUNT_NOT_CONNECTED',
          provider: resolvedProvider,
        });
      }
      // 6. Not already ready.
      if (locked.meeting_status === MeetingCreationStatus.READY) {
        throw new ConflictException(
          biBody('This appointment already has a meeting', 'هذا الموعد لديه اجتماع بالفعل'),
        );
      }
      // 7. Not already in progress — this also collapses a double-click:
      // the second concurrent request finds `pending` and is rejected here.
      if (
        locked.meeting_status === MeetingCreationStatus.PENDING ||
        locked.meeting_status === MeetingCreationStatus.CREATING
      ) {
        throw new ConflictException(
          biBody('Meeting creation is already in progress', 'إنشاء الاجتماع جارٍ بالفعل'),
        );
      }
      locked.meeting_provider = resolvedProvider;
      locked.meeting_account_id = account.id;
      locked.meeting_status = MeetingCreationStatus.PENDING;
      const requestedAt = new Date();
      requestedAtMs = requestedAt.getTime();
      locked.meeting_requested_at = requestedAt;
      locked.meeting_error = null;
      await manager.save(locked);
      return this.toPrivilegedSession(locked);
    });
    // Without Redis (`NoopQueue`) nothing would ever consume the job and the
    // row would sit in `pending` forever, so provision inline instead.
    if (this.meetingQueue instanceof NoopQueue) {
      await this.provisionMeeting(sessionId);
      const refreshed = await this.dataSource
        .getRepository(ScheduledLessonSession)
        .findOne({ where: { id: sessionId } });
      return refreshed ? this.toPrivilegedSession(refreshed) : session;
    }
    // Enqueued only after commit (AD-9). The job id carries this request's
    // timestamp: a fixed per-session id would be silently ignored by BullMQ
    // while an earlier (completed or failed) job for the same session is
    // still retained, wedging every Retry/regenerate in `pending`. It still
    // deduplicates a retried enqueue of the SAME request, and the worker's
    // conditional claim is the second independent stop.
    await this.meetingQueue.add(
      JOB_TYPES.MEETING.PROVISION,
      { sessionId },
      { jobId: queueJobId('meeting', 'provision', sessionId, requestedAtMs) },
    );
    return session;
  }

  /**
   * `DELETE .../meeting` — clears a `ready` or `failed` meeting so the
   * teacher can switch provider (R-17) or retry cleanly. Refused outright
   * once a booking is confirmed (the student already holds that link); the
   * teacher must cancel the slot through the existing refund path instead.
   */
  public async clearMeetingGeneration(
    lessonId: string,
    sessionId: string,
    teacherId: string,
  ): Promise<Record<string, unknown>> {
    const { session, providerToDelete, externalId } = await retryTransaction(
      this.dataSource,
      async (manager) => {
        const locked = await this.lockOwnedSession(manager, lessonId, sessionId, teacherId);
        if (
          locked.meeting_status !== MeetingCreationStatus.READY &&
          locked.meeting_status !== MeetingCreationStatus.FAILED
        ) {
          throw new ConflictException(
            biBody('There is no meeting to remove', 'لا يوجد اجتماع لإزالته'),
          );
        }
        const active = await this.findActiveBooking(manager, locked.id);
        if (active?.status === LessonSessionBookingStatus.CONFIRMED) {
          throw new ConflictException(
            biBody(
              'Cancel the appointment to change its meeting once it is booked',
              'ألغِ الموعد لتغيير اجتماعه بعد حجزه',
            ),
          );
        }
        const providerToDelete = locked.meeting_provider;
        const externalId = locked.external_meeting_id;
        locked.meeting_provider = null;
        locked.meeting_account_id = null;
        locked.meeting_status = MeetingCreationStatus.NOT_REQUESTED;
        locked.external_meeting_id = null;
        locked.meeting_url = null;
        locked.meeting_host_url = null;
        locked.meeting_passcode = null;
        locked.meeting_error = null;
        locked.meeting_ready_at = null;
        await manager.save(locked);
        return { session: this.toPrivilegedSession(locked), providerToDelete, externalId };
      },
    );
    if (providerToDelete && providerToDelete !== MeetingProvider.MANUAL && externalId) {
      // Best-effort: the local clear must succeed regardless of whether the
      // provider-side delete does (R-18's same reasoning as account disconnect).
      const account = await this.meetingAccounts
        .getUsableAccount(teacherId, providerToDelete)
        .catch(() => null);
      const client = this.meetingProviders.find(providerToDelete);
      if (client && account?.access_token_encrypted) {
        await client
          .deleteMeeting(account.access_token_encrypted, externalId)
          .catch(() => undefined);
      }
    }
    return session;
  }

  /**
   * Worker entry point (`MeetingProvisioningProcessor`). Conditionally claims
   * the row (`pending` -> `creating`) so a duplicate job is a no-op (AD-8
   * layer 2), calls the provider, and persists the result. A definitive
   * failure is recorded on the row (`failed` + `meeting_error`) rather than
   * surfaced to BullMQ's retry, since a bad provider/account state will not
   * resolve itself by retrying automatically; the teacher retries explicitly.
   * The one exception is a TRANSIENT provider failure (timeout, 429, 5xx):
   * unless this is the `finalAttempt`, the row goes back to `pending` and the
   * error is rethrown so BullMQ retries with its exponential backoff.
   */
  public async provisionMeeting(
    sessionId: string,
    options: { finalAttempt?: boolean } = {},
  ): Promise<void> {
    const finalAttempt = options.finalAttempt ?? true;
    const repository = this.dataSource.getRepository(ScheduledLessonSession);
    const claim = await repository.update(
      { id: sessionId, meeting_status: MeetingCreationStatus.PENDING },
      { meeting_status: MeetingCreationStatus.CREATING },
    );
    if (!claim.affected) return;

    const session = await repository.findOne({ where: { id: sessionId }, relations: ['lesson'] });
    if (!session || !session.meeting_provider) return;

    const client = this.meetingProviders.find(session.meeting_provider);
    let account: TeacherMeetingAccount | null = null;
    try {
      account = client
        ? await this.meetingAccounts.getUsableAccount(session.teacher_id, session.meeting_provider)
        : null;
    } catch (error) {
      if (error instanceof RetryableProviderError) {
        await this.handleRetryableMeetingFailure(session, error, finalAttempt);
        return;
      }
      throw error;
    }
    if (!client || !account || !account.access_token_encrypted) {
      session.meeting_status = MeetingCreationStatus.FAILED;
      session.meeting_error = !client
        ? 'Meeting provider is not available'
        : 'Meeting account is not connected';
      session.meeting_attempts += 1;
      await repository.save(session).catch(() => undefined);
      // `getUsableAccount` above may have just flipped a CONNECTED account to
      // EXPIRED/REVOKED (a proactive-refresh or invalid_grant failure) —
      // that specific transition is what earns the separate
      // `meeting_account_expired` notification (Phase 8), distinct from the
      // per-attempt `meeting_creation_failed` below which always fires.
      if (client) {
        const accountRow = await this.dataSource.getRepository(TeacherMeetingAccount).findOne({
          where: { teacher_id: session.teacher_id, provider: session.meeting_provider },
        });
        if (
          accountRow &&
          (accountRow.status === TeacherMeetingAccountStatus.EXPIRED ||
            accountRow.status === TeacherMeetingAccountStatus.REVOKED)
        ) {
          await this.notifyMeetingAccountExpired(accountRow).catch(() => undefined);
        }
      }
      await this.notifyMeetingCreationFailed(session).catch(() => undefined);
      return;
    }

    try {
      const result = await client.createMeeting({
        accessToken: account.access_token_encrypted,
        topic: session.lesson.title,
        startAt: session.start_at,
        endAt: session.end_at,
        timezone: resolveAppTimeZone(),
        // Deterministic per-REQUEST key (AD-8 layer 3 / R-13): a retried call
        // for this Generate returns the SAME meeting, while Remove + regenerate
        // gets a fresh key (a deleted Google event id cannot be reused).
        idempotencyKey: session.meeting_requested_at
          ? `${session.id}-${String(session.meeting_requested_at.getTime())}`
          : session.id,
      });
      session.external_meeting_id = result.externalId;
      session.meeting_url = result.joinUrl;
      session.meeting_host_url = result.hostUrl ?? null;
      session.meeting_passcode = result.passcode ?? null;
      session.meeting_account_id = account.id;
      session.meeting_status = MeetingCreationStatus.READY;
      session.meeting_ready_at = new Date();
      session.meeting_error = null;
      session.meeting_attempts += 1;
      try {
        await repository.save(session);
      } catch (saveError) {
        if (!this.isUniqueViolation(saveError)) throw saveError;
        // R-13: the DB-level idempotency guarantee caught a genuine duplicate
        // (two calls landed two different external ids). This call is the
        // loser — clean up the meeting it just created rather than leave it
        // orphaned on the teacher's account.
        await client
          .deleteMeeting(account.access_token_encrypted, result.externalId)
          .catch(() => undefined);
        session.meeting_status = MeetingCreationStatus.FAILED;
        session.meeting_error = 'This meeting already exists';
        session.external_meeting_id = null;
        session.meeting_url = null;
        session.meeting_host_url = null;
        session.meeting_passcode = null;
        await repository.save(session).catch(() => undefined);
        await this.notifyMeetingCreationFailed(session).catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof RetryableProviderError) {
        await this.handleRetryableMeetingFailure(session, error, finalAttempt);
        return;
      }
      session.meeting_status = MeetingCreationStatus.FAILED;
      session.meeting_error = error instanceof Error ? error.message : 'Meeting creation failed';
      session.meeting_attempts += 1;
      await repository.save(session).catch(() => undefined);
      await this.notifyMeetingCreationFailed(session).catch(() => undefined);
    }
  }

  /** After-commit: push the new time to the provider (job, or inline without Redis). */
  private async enqueueMeetingTimeSync(sessionId: string): Promise<void> {
    if (this.meetingQueue instanceof NoopQueue) {
      await this.syncMeetingTime(sessionId).catch(() => undefined);
      return;
    }
    await this.meetingQueue
      .add(
        JOB_TYPES.MEETING.SYNC,
        { sessionId },
        // Unique per edit so two reschedules are never collapsed into one job.
        { jobId: queueJobId('meeting', 'sync', sessionId, Date.now()) },
      )
      .catch(() => undefined);
  }

  /**
   * Transient provider failure during provisioning. Not final: put the row back
   * to `pending` (so the retry's conditional claim succeeds) and rethrow so
   * BullMQ backs off and retries. Final: record `failed` for the teacher.
   */
  private async handleRetryableMeetingFailure(
    session: ScheduledLessonSession,
    error: RetryableProviderError,
    finalAttempt: boolean,
  ): Promise<void> {
    const repository = this.dataSource.getRepository(ScheduledLessonSession);
    if (!finalAttempt) {
      session.meeting_status = MeetingCreationStatus.PENDING;
      await repository.save(session);
      throw error;
    }
    session.meeting_status = MeetingCreationStatus.FAILED;
    session.meeting_error = 'The meeting provider is temporarily unavailable — please retry';
    session.meeting_attempts += 1;
    await repository.save(session).catch(() => undefined);
    await this.notifyMeetingCreationFailed(session).catch(() => undefined);
  }

  /**
   * Pushes a rescheduled slot's new time to its provider meeting. Runs from the
   * `sync-meeting` job (or inline without Redis). The meeting stays `ready` on
   * failure — the join link is still valid — and `meeting_error` tells the
   * teacher the provider still shows the old time.
   */
  public async syncMeetingTime(
    sessionId: string,
    options: { finalAttempt?: boolean } = {},
  ): Promise<void> {
    const finalAttempt = options.finalAttempt ?? true;
    const repository = this.dataSource.getRepository(ScheduledLessonSession);
    const session = await repository.findOne({ where: { id: sessionId }, relations: ['lesson'] });
    if (
      !session ||
      session.meeting_status !== MeetingCreationStatus.READY ||
      !session.external_meeting_id ||
      !session.meeting_provider ||
      session.meeting_provider === MeetingProvider.MANUAL ||
      session.status !== ScheduledLessonSessionStatus.SCHEDULED
    ) {
      return;
    }
    const client = this.meetingProviders.find(session.meeting_provider);
    try {
      const account = client
        ? await this.meetingAccounts.getUsableAccount(session.teacher_id, session.meeting_provider)
        : null;
      if (!client || !account?.access_token_encrypted) {
        session.meeting_error = 'Could not update the meeting time — reconnect your account';
        await repository.save(session);
        return;
      }
      await client.updateMeeting(account.access_token_encrypted, session.external_meeting_id, {
        topic: session.lesson.title,
        startAt: session.start_at,
        endAt: session.end_at,
        timezone: resolveAppTimeZone(),
      });
      if (session.meeting_error) {
        session.meeting_error = null;
        await repository.save(session);
      }
    } catch (error) {
      if (error instanceof RetryableProviderError && !finalAttempt) throw error;
      session.meeting_error = 'The meeting time could not be updated at the provider';
      await repository.save(session).catch(() => undefined);
    }
  }

  /**
   * Deletes the provider meeting of a CANCELLED appointment and clears the
   * local meeting fields. Idempotent and driven by a sweep, so it also covers
   * cancellations that complete later (refund of a confirmed booking) without
   * enqueueing from inside the payments transaction.
   */
  public async releaseCancelledSessionMeeting(sessionId: string): Promise<boolean> {
    const repository = this.dataSource.getRepository(ScheduledLessonSession);
    const session = await repository.findOne({ where: { id: sessionId } });
    if (
      !session ||
      session.status !== ScheduledLessonSessionStatus.CANCELLED ||
      !session.external_meeting_id ||
      !session.meeting_provider ||
      session.meeting_provider === MeetingProvider.MANUAL
    ) {
      return false;
    }
    const client = this.meetingProviders.find(session.meeting_provider);
    const account = client
      ? await this.meetingAccounts.getUsableAccount(session.teacher_id, session.meeting_provider)
      : null;
    // No usable account (disconnected/revoked): keep the reference so a later
    // sweep can still delete it once the teacher reconnects.
    if (!client || !account?.access_token_encrypted) return false;
    await client.deleteMeeting(account.access_token_encrypted, session.external_meeting_id);
    await repository.update(
      { id: session.id, external_meeting_id: session.external_meeting_id },
      {
        external_meeting_id: null,
        meeting_url: null,
        meeting_host_url: null,
        meeting_passcode: null,
        meeting_account_id: null,
        meeting_status: MeetingCreationStatus.NOT_REQUESTED,
        meeting_error: null,
        meeting_ready_at: null,
      },
    );
    return true;
  }

  /** Maintenance sweep: releases provider meetings of recently cancelled appointments. */
  public async sweepCancelledSessionMeetings(): Promise<number> {
    const since = new Date(Date.now() - 7 * 24 * 3600_000);
    const candidates = await this.dataSource.getRepository(ScheduledLessonSession).find({
      where: {
        status: ScheduledLessonSessionStatus.CANCELLED,
        meeting_status: MeetingCreationStatus.READY,
        cancelled_at: MoreThanOrEqual(since),
      },
      select: { id: true, external_meeting_id: true, meeting_provider: true },
      take: 50,
    });
    let released = 0;
    for (const candidate of candidates) {
      if (!candidate.external_meeting_id) continue;
      const done = await this.releaseCancelledSessionMeeting(candidate.id).catch(() => false);
      if (done) released += 1;
    }
    return released;
  }

  public async getCheckoutProduct(
    sessionId: string,
    manager?: EntityManager,
  ): Promise<{
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
      ? await manager.findOne(ScheduledLessonSession, {
          where: { id: booking.scheduled_session_id },
        })
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
      ? await manager.findOne(ScheduledLessonSession, {
          where: { id: booking.scheduled_session_id },
        })
      : null;
    const lesson = session
      ? await manager.findOne(Lesson, { where: { id: session.lesson_id } })
      : null;
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

  private async notifyBookingEvent(
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
  private async notifyMeetingCreationFailed(session: ScheduledLessonSession): Promise<void> {
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
  private async notifyMeetingAccountExpired(account: TeacherMeetingAccount): Promise<void> {
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
        biBody(
          'Session times must define a valid future interval',
          'يجب أن تحدد أوقات الجلسة فترة صحيحة في المستقبل',
        ),
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
        biBody(
          'This appointment overlaps another teacher appointment',
          'يتداخل هذا الموعد مع موعد آخر للمعلم',
        ),
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

  /** True while a meeting is live or being created — the R-17 guard shared by provider- and manual-URL edits. */
  private hasActiveOrReadyMeeting(session: ScheduledLessonSession): boolean {
    return (
      session.meeting_status === MeetingCreationStatus.READY ||
      session.meeting_status === MeetingCreationStatus.PENDING ||
      session.meeting_status === MeetingCreationStatus.CREATING
    );
  }

  private isUniqueViolation(error: unknown): boolean {
    return (error as DatabaseError).code === '23505';
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
        ? {
            id: lesson.id,
            title: lesson.title,
            duration: lesson.duration,
            teacher_id: lesson.teacher_id,
          }
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
      // Teacher-only fields (never present on toSafeSession/toStudentBooking).
      meeting_provider: session.meeting_provider,
      meeting_status: session.meeting_status,
      meeting_host_url: session.meeting_host_url,
      meeting_passcode: session.meeting_passcode,
      meeting_error: session.meeting_error,
      meeting_attempts: session.meeting_attempts,
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
        mayShowStudent && booking.student
          ? { id: booking.student.id, name: booking.student.name }
          : null,
      order: booking.order
        ? { id: booking.order.id, number: booking.order.order_number, status: booking.order.status }
        : null,
      payment: booking.payment ? { id: booking.payment.id, status: booking.payment.status } : null,
    };
  }
}
