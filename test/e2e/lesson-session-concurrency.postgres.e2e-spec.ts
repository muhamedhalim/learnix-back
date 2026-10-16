import * as fs from 'node:fs';
import * as path from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { LessonSessionBookingStatus } from '../../src/lessons/entities/lesson-session-booking-status.enum';
import { LessonSessionBooking } from '../../src/lessons/entities/lesson-session-booking.entity';
import { MeetingCreationStatus } from '../../src/lessons/entities/meeting-creation-status.enum';
import { MeetingProvider } from '../../src/lessons/entities/meeting-provider.enum';
import { ScheduledLessonSessionStatus } from '../../src/lessons/entities/scheduled-lesson-session-status.enum';
import { ScheduledLessonSession } from '../../src/lessons/entities/scheduled-lesson-session.entity';
import { LessonSessionsService } from '../../src/lessons/lesson-sessions.service';
import { NotificationEmailService } from '../../src/notifications/services/notification-email.service';
import { PaymentsService } from '../../src/payments/services/payments.service';
import { RefundsService } from '../../src/payments/services/refunds.service';
import {
  CollectionParty,
  Entitlement,
  EntitlementStatus,
  ItemType,
  LessonPurchase,
  Order,
  OrderStatus,
  Payment,
  PaymentChannel,
  PaymentMethod,
  PaymentStatus,
  Refund,
  RefundStatus,
} from '../../src/payments/entities';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { createE2EApp, resetDatabase } from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

describe('one-to-one reservation concurrency (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let service: LessonSessionsService;
  let payments: PaymentsService;
  let refunds: RefundsService;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    service = app.get(LessonSessionsService);
    payments = app.get(PaymentsService);
    refunds = app.get(RefundsService);
  });
  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  it('allows exactly one active booking for a slot while another slot stays independent', async () => {
    const users = dataSource.getRepository(User);
    const makeUser = async (suffix: string, role: UserRole) =>
      users.save(
        users.create({
          username: `session-${suffix}`,
          name: `Session ${suffix}`,
          first_name: null,
          last_name: null,
          email: `session-${suffix}@example.test`,
          phone: `01088${suffix.padStart(6, '0')}`,
          role,
          status: UserStatus.APPROVED,
          is_active: true,
          password_hash: null,
        }),
      );
    const teacher = await makeUser('1', UserRole.TEACHER);
    const studentA = await makeUser('2', UserRole.STUDENT);
    const studentB = await makeUser('3', UserRole.STUDENT);
    const subject = await dataSource.getRepository(Subject).save(
      dataSource.getRepository(Subject).create({
        name: 'Concurrency subject',
        name_ar: null,
        description: null,
        description_ar: null,
        thumbnail: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
    const lesson = await dataSource.getRepository(Lesson).save(
      dataSource.getRepository(Lesson).create({
        title: 'Concurrent booking lesson',
        description: null,
        teacher_id: teacher.id,
        subject_id: subject.id,
        thumbnail: null,
        price: 500,
        duration: 3_600,
        is_group: false,
        available_for_days: 7,
        students_count: 0,
        is_free_preview: false,
      }),
    );
    const start = new Date(Date.now() + 48 * 60 * 60_000);
    const makeSlot = async (offsetHours: number) => {
      const startAt = new Date(start.getTime() + offsetHours * 60 * 60_000);
      return dataSource.getRepository(ScheduledLessonSession).save(
        dataSource.getRepository(ScheduledLessonSession).create({
          lesson_id: lesson.id,
          teacher_id: teacher.id,
          start_at: startAt,
          end_at: new Date(startAt.getTime() + 3_600_000),
          status: ScheduledLessonSessionStatus.SCHEDULED,
          meeting_url: 'https://meet.example.test/private-room',
          cancellation_reason: null,
          cancellation_requested_at: null,
          cancelled_at: null,
        }),
      );
    };
    const firstSlot = await makeSlot(0);
    const secondSlot = await makeSlot(24);

    const attempts = await Promise.allSettled([
      service.reserve(firstSlot.id, studentA.id),
      service.reserve(firstSlot.id, studentB.id),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(ConflictException) });

    const activeBooking = await dataSource.getRepository(LessonSessionBooking).findOneOrFail({
      where: {
        scheduled_session_id: firstSlot.id,
        status: LessonSessionBookingStatus.HELD,
      },
    });
    expect(
      await dataSource.getRepository(LessonSessionBooking).countBy({
        scheduled_session_id: firstSlot.id,
        status: LessonSessionBookingStatus.HELD,
      }),
    ).toBe(1);

    const otherStudent = activeBooking.student_id === studentA.id ? studentB.id : studentA.id;
    await expect(service.reserve(secondSlot.id, otherStudent)).resolves.toMatchObject({
      status: LessonSessionBookingStatus.HELD,
      session: { id: secondSlot.id },
    });
  });

  it('keeps parent lesson access when a refund revokes only one of two confirmed sessions', async () => {
    const users = dataSource.getRepository(User);
    const makeUser = async (suffix: string, role: UserRole) =>
      users.save(
        users.create({
          username: `refund-session-${suffix}`,
          name: `Refund Session ${suffix}`,
          first_name: null,
          last_name: null,
          email: `refund-session-${suffix}@example.test`,
          phone: `01177${suffix.padStart(6, '0')}`,
          role,
          status: UserStatus.APPROVED,
          is_active: true,
          password_hash: null,
        }),
      );
    const teacher = await makeUser('11', UserRole.TEACHER);
    const student = await makeUser('12', UserRole.STUDENT);
    const admin = await makeUser('13', UserRole.ADMIN);
    const subjectRepository = dataSource.getRepository(Subject);
    const subject = await subjectRepository.save(
      subjectRepository.create({
        name: 'Refund access subject',
        name_ar: null,
        description: null,
        description_ar: null,
        thumbnail: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
    const lessons = dataSource.getRepository(Lesson);
    const lesson = await lessons.save(
      lessons.create({
        title: 'Two appointments, one parent lesson',
        description: null,
        teacher_id: teacher.id,
        subject_id: subject.id,
        thumbnail: null,
        price: 500,
        duration: 3_600,
        is_group: false,
        available_for_days: 7,
        students_count: 0,
        is_free_preview: false,
      }),
    );
    const sessions = dataSource.getRepository(ScheduledLessonSession);
    const baseStart = new Date(Date.now() + 72 * 60 * 60_000);
    const makeSession = async (hours: number) => {
      const startAt = new Date(baseStart.getTime() + hours * 60 * 60_000);
      return sessions.save(
        sessions.create({
          lesson_id: lesson.id,
          teacher_id: teacher.id,
          start_at: startAt,
          end_at: new Date(startAt.getTime() + 3_600_000),
          status: ScheduledLessonSessionStatus.SCHEDULED,
          meeting_url: 'https://meet.example.test/refund-access',
          cancellation_reason: null,
          cancellation_requested_at: null,
          cancelled_at: null,
        }),
      );
    };
    const sessionA = await makeSession(0);
    const sessionB = await makeSession(24);

    const createConfirmedPurchase = async (session: ScheduledLessonSession, suffix: string) => {
      const orders = dataSource.getRepository(Order);
      const order = await orders.save(
        orders.create({
          order_number: `E2E-REFUND-${suffix}`,
          student_id: student.id,
          teacher_id: teacher.id,
          item_type: ItemType.LESSON_SESSION,
          item_id: session.id,
          quantity: 1,
          original_amount_minor: 50_000,
          discount_amount_minor: 0,
          final_amount_minor: 50_000,
          refunded_amount_minor: 0,
          currency: 'EGP',
          payment_channel: PaymentChannel.MANUAL,
          payment_method: PaymentMethod.MANUAL,
          status: OrderStatus.PAID,
          discount_code_id: null,
          activation_code_id: null,
          payment_id: null,
          collection_party: CollectionParty.PLATFORM,
          product_title_snapshot: lesson.title,
          product_title_ar_snapshot: null,
          seller_name_snapshot: teacher.name,
          platform_commission_bps: 1_000,
          platform_commission_minor: 5_000,
          teacher_earning_minor: 45_000,
          gateway_fee_bps: 0,
          gateway_fee_minor: 0,
          discount_snapshot: null,
          metadata: { access_duration_days: 7 },
          expires_at: null,
          paid_at: new Date(),
          cancelled_at: null,
        }),
      );
      const paymentRepository = dataSource.getRepository(Payment);
      const payment = await paymentRepository.save(
        paymentRepository.create({
          order_id: order.id,
          user_id: student.id,
          item_type: ItemType.LESSON_SESSION,
          item_id: session.id,
          amount: 500,
          discount_amount: 0,
          final_amount: 500,
          amount_minor: 50_000,
          currency: 'EGP',
          channel: PaymentChannel.MANUAL,
          provider: null,
          provider_reference: `e2e-refund-${suffix}`,
          status: PaymentStatus.COMPLETED,
          payment_method: PaymentMethod.MANUAL,
          provider_order_reference: null,
          provider_transaction_id: null,
          idempotency_key: `e2e-refund-payment-${suffix}`,
          failure_reason: null,
          completed_at: new Date(),
        }),
      );
      order.payment_id = payment.id;
      await orders.save(order);
      const now = new Date();
      await dataSource.getRepository(Entitlement).save(
        dataSource.getRepository(Entitlement).create({
          student_id: student.id,
          item_type: ItemType.LESSON_SESSION,
          item_id: session.id,
          order_id: order.id,
          payment_id: payment.id,
          source_channel: PaymentChannel.MANUAL,
          status: EntitlementStatus.ACTIVE,
          granted_at: now,
          starts_at: now,
          expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60_000),
          revoked_at: null,
          revocation_reason: null,
        }),
      );
      await dataSource.getRepository(LessonPurchase).save(
        dataSource.getRepository(LessonPurchase).create({
          student_id: student.id,
          lesson_id: lesson.id,
          payment_id: payment.id,
          price_paid: 500,
          access_granted_at: now,
          access_expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60_000),
          days_extended: 0,
          revoked_at: null,
          revocation_reason: null,
        }),
      );
      await dataSource.getRepository(LessonSessionBooking).save(
        dataSource.getRepository(LessonSessionBooking).create({
          scheduled_session_id: session.id,
          student_id: student.id,
          order_id: order.id,
          payment_id: payment.id,
          status: LessonSessionBookingStatus.CONFIRMED,
          hold_expires_at: new Date(now.getTime() + 10 * 60_000),
          price_minor_snapshot: 50_000,
          currency: 'EGP',
          confirmed_at: now,
          expired_at: null,
          failed_at: null,
          cancelled_at: null,
          refunded_at: null,
        }),
      );
      return { order, payment };
    };

    const purchaseA = await createConfirmedPurchase(sessionA, 'A');
    const purchaseB = await createConfirmedPurchase(sessionB, 'B');
    expect(await payments.hasLessonPlaybackAccess(student.id, lesson.id)).toBe(true);

    const refundRepository = dataSource.getRepository(Refund);
    const refund = await refundRepository.save(
      refundRepository.create({
        order_id: purchaseA.order.id,
        payment_id: purchaseA.payment.id,
        channel: PaymentChannel.MANUAL,
        amount_minor: 50_000,
        currency: 'EGP',
        status: RefundStatus.APPROVED,
        reason_code: 'e2e_session_a_refund',
        reason: 'Refund only the first appointment',
        internal_note: null,
        external_method: null,
        external_reference: null,
        proof_file_key: null,
        requested_by: admin.id,
        approved_by: admin.id,
        completed_by: null,
        completed_at: null,
        metadata: null,
      }),
    );
    await refunds.complete(
      refund.id,
      { external_method: 'manual', external_reference: 'e2e-refund-session-a' },
      admin.id,
      true,
    );

    expect(await payments.hasLessonPlaybackAccess(student.id, lesson.id)).toBe(true);
    await expect(
      dataSource
        .getRepository(LessonSessionBooking)
        .findOneByOrFail({ order_id: purchaseA.order.id }),
    ).resolves.toMatchObject({ status: LessonSessionBookingStatus.REFUNDED });
    await expect(
      dataSource
        .getRepository(LessonSessionBooking)
        .findOneByOrFail({ order_id: purchaseB.order.id }),
    ).resolves.toMatchObject({ status: LessonSessionBookingStatus.CONFIRMED });
    await expect(
      dataSource.getRepository(Entitlement).findOneByOrFail({ order_id: purchaseA.order.id }),
    ).resolves.toMatchObject({ status: EntitlementStatus.REVOKED });
    await expect(
      dataSource.getRepository(Entitlement).findOneByOrFail({ order_id: purchaseB.order.id }),
    ).resolves.toMatchObject({ status: EntitlementStatus.ACTIVE });
    const survivingPurchase = await dataSource.getRepository(LessonPurchase).findOneByOrFail({
      payment_id: purchaseB.payment.id,
    });
    expect(survivingPurchase.revoked_at).toBeNull();
  });

  /**
   * Phase 9 regression: the Phase 5 meeting columns (`meeting_provider`,
   * `meeting_status`, etc.) are additive — a slot whose meeting was
   * explicitly generated (rather than hand-typed, as every other test in
   * this file uses) must still be protected by the exact same double-booking
   * guarantees (partial unique index + advisory lock + row lock).
   */
  it('still allows exactly one active booking for a slot whose meeting was generated via a provider', async () => {
    const users = dataSource.getRepository(User);
    const makeUser = async (suffix: string, role: UserRole) =>
      users.save(
        users.create({
          username: `generated-session-${suffix}`,
          name: `Generated Session ${suffix}`,
          first_name: null,
          last_name: null,
          email: `generated-session-${suffix}@example.test`,
          phone: `01099${suffix.padStart(6, '0')}`,
          role,
          status: UserStatus.APPROVED,
          is_active: true,
          password_hash: null,
        }),
      );
    const teacher = await makeUser('1', UserRole.TEACHER);
    const studentA = await makeUser('2', UserRole.STUDENT);
    const studentB = await makeUser('3', UserRole.STUDENT);
    const subjectRepository = dataSource.getRepository(Subject);
    const subject = await subjectRepository.save(
      subjectRepository.create({
        name: 'Generated meeting concurrency subject',
        name_ar: null,
        description: null,
        description_ar: null,
        thumbnail: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
    const lessonRepository = dataSource.getRepository(Lesson);
    const lesson = await lessonRepository.save(
      lessonRepository.create({
        title: 'Generated-meeting concurrency lesson',
        description: null,
        teacher_id: teacher.id,
        subject_id: subject.id,
        thumbnail: null,
        price: 500,
        duration: 3_600,
        is_group: false,
        available_for_days: 7,
        students_count: 0,
        is_free_preview: false,
      }),
    );
    const sessionRepository = dataSource.getRepository(ScheduledLessonSession);
    const startAt = new Date(Date.now() + 48 * 60 * 60_000);
    const slot = await sessionRepository.save(
      sessionRepository.create({
        lesson_id: lesson.id,
        teacher_id: teacher.id,
        start_at: startAt,
        end_at: new Date(startAt.getTime() + 3_600_000),
        status: ScheduledLessonSessionStatus.SCHEDULED,
        // As `provisionMeeting` would leave it after a successful Generate —
        // exercised end-to-end in meeting-generation.postgres.e2e-spec.ts;
        // this test's only concern is that concurrency guarantees don't care.
        meeting_provider: MeetingProvider.GOOGLE_MEET,
        meeting_status: MeetingCreationStatus.READY,
        meeting_url: 'https://meet.google.com/generated-concurrency',
        external_meeting_id: 'ext-concurrency-1',
        cancellation_reason: null,
        cancellation_requested_at: null,
        cancelled_at: null,
      }),
    );

    const attempts = await Promise.allSettled([
      service.reserve(slot.id, studentA.id),
      service.reserve(slot.id, studentB.id),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(ConflictException),
    });
    expect(
      await dataSource.getRepository(LessonSessionBooking).countBy({
        scheduled_session_id: slot.id,
        status: LessonSessionBookingStatus.HELD,
      }),
    ).toBe(1);
  });

  /**
   * T070 (W4-C6): the reminder cron's candidate predicate must send exactly what the
   * unrestricted predicate sent, three runs in a row, including at the window
   * boundaries. `lesson-session-reminders.golden.json` was captured from the cron BEFORE
   * the predicate was narrowed (`UPDATE_REMINDER_GOLDEN=1` on that code). The cron clock is
   * pinned through its `currentTime` seam so "exactly +24 h" and "exactly +1 h" are exact.
   */
  describe('reminder cron candidates (T070)', () => {
    const GOLDEN = path.join(__dirname, 'fixtures', 'lesson-session-reminders.golden.json');
    const HOUR = 3_600_000;
    let phoneSeq = 0;

    async function seedBookings(frozen: Date): Promise<{
      labels: Map<string, string>;
      users: Map<string, string>;
    }> {
      const users = dataSource.getRepository(User);
      const makeUser = async (tag: string, role: UserRole, preferred: 'ar' | 'en') =>
        users.save(
          users.create({
            username: `rem-${tag}`,
            name: `Reminder ${tag}`,
            first_name: null,
            last_name: null,
            email: `rem-${tag}@example.test`,
            phone: `0129${String((phoneSeq += 1)).padStart(7, '0')}`,
            role,
            status: UserStatus.APPROVED,
            is_active: true,
            password_hash: null,
            preferred_language: preferred as never,
          }),
        );
      const teacher = await makeUser('teacher', UserRole.TEACHER, 'en');
      const subject = await dataSource.getRepository(Subject).save(
        dataSource.getRepository(Subject).create({
          name: 'Reminder subject',
          name_ar: null,
          description: null,
          description_ar: null,
          thumbnail: null,
          status: SubjectStatus.APPROVED,
          created_by_teacher_id: null,
          rejection_reason: null,
          reviewed_by_admin_id: null,
          reviewed_at: null,
        }),
      );
      const lessons = dataSource.getRepository(Lesson);
      const makeLesson = async (title: string, deleted = false) => {
        const saved = await lessons.save(
          lessons.create({
            title,
            description: null,
            teacher_id: teacher.id,
            subject_id: subject.id,
            thumbnail: null,
            price: 500,
            duration: 3_600,
            is_group: false,
            available_for_days: 7,
            students_count: 0,
            is_free_preview: false,
          }),
        );
        if (deleted) await lessons.softDelete({ id: saved.id });
        return saved;
      };
      const lesson = await makeLesson('Reminder lesson');
      const deletedLesson = await makeLesson('Deleted reminder lesson', true);

      const labels = new Map<string, string>();
      const userIds = new Map<string, string>([['teacher', teacher.id]]);
      labels.set(teacher.id, 'teacher');
      const confirmedBoth: Array<{ event: string; who: 'student' | 'teacher' }> = [
        { event: 'confirmed', who: 'student' },
        { event: 'confirmed', who: 'teacher' },
      ];
      const cases: Array<{
        key: string;
        offsetMs: number;
        lessonId?: string;
        keysPresent?: Array<{ event: string; who: 'student' | 'teacher' }>;
        arabic?: boolean;
      }> = [
        { key: 'plus30h', offsetMs: 30 * HOUR },
        { key: 'plus24h-exact', offsetMs: 24 * HOUR },
        { key: 'plus24h-1ms', offsetMs: 24 * HOUR + 1 },
        { key: 'plus23h', offsetMs: 23 * HOUR, arabic: true },
        { key: 'plus59m', offsetMs: 59 * 60_000 },
        { key: 'plus1h-exact', offsetMs: HOUR },
        { key: 'plus1h-1ms', offsetMs: HOUR + 1 },
        { key: 'plus30m', offsetMs: 30 * 60_000 },
        { key: 'started-1h-ago', offsetMs: -HOUR },
        {
          key: '24h-already-sent',
          offsetMs: 23 * HOUR,
          keysPresent: [
            { event: 'confirmed', who: 'student' },
            { event: 'confirmed', who: 'teacher' },
            { event: 'reminder_24h', who: 'student' },
            { event: 'reminder_24h', who: 'teacher' },
          ],
        },
        {
          key: '1h-already-sent',
          offsetMs: 30 * 60_000,
          keysPresent: [
            { event: 'confirmed', who: 'student' },
            { event: 'confirmed', who: 'teacher' },
            { event: 'reminder_1h', who: 'student' },
            { event: 'reminder_1h', who: 'teacher' },
          ],
        },
        {
          key: 'teacher-key-only',
          offsetMs: 23 * HOUR,
          keysPresent: [
            { event: 'confirmed', who: 'teacher' },
            { event: 'reminder_24h', who: 'teacher' },
          ],
        },
        { key: 'soft-deleted-lesson', offsetMs: 23 * HOUR, lessonId: deletedLesson.id },
        // Confirmation already delivered: only a reminder window (or one missing key) can make
        // these candidates, which is what the window clauses exist for.
        { key: 'c-plus30h', offsetMs: 30 * HOUR, keysPresent: confirmedBoth },
        { key: 'c-plus24h-exact', offsetMs: 24 * HOUR, keysPresent: confirmedBoth },
        { key: 'c-plus24h-1ms', offsetMs: 24 * HOUR + 1, keysPresent: confirmedBoth },
        { key: 'c-plus23h', offsetMs: 23 * HOUR, keysPresent: confirmedBoth },
        { key: 'c-plus1h-exact', offsetMs: HOUR, keysPresent: confirmedBoth },
        { key: 'c-plus1h-1ms', offsetMs: HOUR + 1, keysPresent: confirmedBoth },
        { key: 'c-plus59m', offsetMs: 59 * 60_000, keysPresent: confirmedBoth },
        {
          key: 'c-student-confirmed-missing-far',
          offsetMs: 30 * HOUR,
          keysPresent: [{ event: 'confirmed', who: 'teacher' }],
        },
        {
          key: 'c-teacher-confirmed-missing-far',
          offsetMs: 30 * HOUR,
          keysPresent: [{ event: 'confirmed', who: 'student' }],
        },
        {
          key: 'c-24h-student-missing',
          offsetMs: 23 * HOUR,
          keysPresent: [...confirmedBoth, { event: 'reminder_24h', who: 'teacher' }],
        },
        {
          key: 'c-1h-teacher-missing',
          offsetMs: 30 * 60_000,
          keysPresent: [...confirmedBoth, { event: 'reminder_1h', who: 'student' }],
        },
      ];

      const sessions = dataSource.getRepository(ScheduledLessonSession);
      const bookings = dataSource.getRepository(LessonSessionBooking);
      for (const [index, entry] of cases.entries()) {
        const student = await makeUser(
          `s-${entry.key}`,
          UserRole.STUDENT,
          entry.arabic === true ? 'ar' : 'en',
        );
        userIds.set(entry.key, student.id);
        labels.set(student.id, `student:${entry.key}`);
        const startAt = new Date(frozen.getTime() + entry.offsetMs);
        const session = await sessions.save(
          sessions.create({
            lesson_id: entry.lessonId ?? lesson.id,
            teacher_id: teacher.id,
            start_at: startAt,
            end_at: new Date(startAt.getTime() + HOUR),
            status: ScheduledLessonSessionStatus.SCHEDULED,
            meeting_url: `https://meet.example.test/${entry.key}`,
            cancellation_reason: null,
            cancellation_requested_at: null,
            cancelled_at: null,
          }),
        );
        const booking = await bookings.save(
          bookings.create({
            scheduled_session_id: session.id,
            student_id: student.id,
            order_id: null,
            payment_id: null,
            status: LessonSessionBookingStatus.CONFIRMED,
            hold_expires_at: new Date(frozen.getTime() - HOUR),
            price_minor_snapshot: 50_000,
            currency: 'EGP',
            confirmed_at: new Date(frozen.getTime() - 2 * HOUR),
            expired_at: null,
            failed_at: null,
            cancelled_at: null,
            refunded_at: null,
          }),
        );
        labels.set(session.id, `session:${entry.key}`);
        labels.set(booking.id, `booking:${entry.key}`);
        for (const present of entry.keysPresent ?? []) {
          const recipient = present.who === 'student' ? student.id : teacher.id;
          await dataSource.query(
            `INSERT INTO notifications (user_id, type, title, message, dedupe_key, origin, status, sent_at, is_read, attempts, sms_sent)
             VALUES ($1, 'custom', 'seeded', 'seeded', $2, 'system', 'sent', now(), false, 0, false)`,
            [
              recipient,
              `lesson-session:${session.id}:booking:${booking.id}:${present.event}:${recipient}`,
            ],
          );
        }
        void index;
      }
      return { labels, users: userIds };
    }

    const labelled = (text: string, labels: Map<string, string>): string => {
      const uuid = new RegExp('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g');
      return text.replace(uuid, (id) => labels.get(id) ?? '<uuid>');
    };

    async function snapshot(
      labels: Map<string, string>,
    ): Promise<Array<{ key: string; user: string; title: string }>> {
      const rows = (await dataSource.query(
        `SELECT dedupe_key, user_id, title FROM notifications ORDER BY dedupe_key ASC`,
      )) as Array<{ dedupe_key: string; user_id: string; title: string }>;
      return rows.map((row) => ({
        key: labelled(row.dedupe_key, labels),
        user: labels.get(row.user_id) ?? row.user_id,
        title: row.title,
      }));
    }

    it('sends exactly what the unrestricted predicate sent over three runs, then goes quiet', async () => {
      const frozen = new Date(Math.floor(Date.now() / 1000) * 1000);
      const { labels } = await seedBookings(frozen);
      const email = jest
        .spyOn(app.get(NotificationEmailService), 'send')
        .mockResolvedValue('sent' as never);
      const clock = jest
        .spyOn(service as unknown as { currentTime: () => Date }, 'currentTime')
        .mockReturnValue(frozen);
      const record: Record<string, unknown> = {};
      const counter = new StatementCounter(dataSource);

      for (const run of [1, 2, 3]) {
        email.mockClear();
        counter.start();
        await service.dispatchScheduledSessionNotifications();
        counter.stop();
        record[`run${String(run)}`] = {
          notifications: await snapshot(labels),
          emails: email.mock.calls
            // The email body ends with the booking's meeting url, which carries the case key.
            .map(
              ([input]) =>
                `${labels.get(input.userId) ?? input.userId} :: ${input.subject} :: ${input.text.slice(input.text.lastIndexOf('/') + 1)}`,
            )
            .sort(),
        };
        if (run === 3) {
          // eslint-disable-next-line no-console
          console.log(
            `T070 run3 statements: ${String(counter.count())} (${String(counter.statements().filter((s) => s.sql.startsWith('INSERT')).length)} inserts)`,
          );
        }
      }
      email.mockRestore();
      clock.mockRestore();

      if (process.env['UPDATE_REMINDER_GOLDEN'] === '1') {
        fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
        fs.writeFileSync(GOLDEN, `${JSON.stringify(record, null, 2)}\n`);
      }
      type Run = { notifications: unknown[]; emails: string[] };
      const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<string, Run>;
      const actual = record as Record<string, Run>;

      // The persisted notifications are the contract: identical to the golden after every run.
      // (Compared by key: the DB order of the raw keys depends on random uuids.)
      const byKey = (rows: unknown[]): unknown[] =>
        [...(rows as Array<{ key: string }>)].sort((a, b) => a.key.localeCompare(b.key));
      for (const run of ['run1', 'run2', 'run3']) {
        expect({ run, notifications: byKey(actual[run]!.notifications) }).toEqual({
          run,
          notifications: byKey(golden[run]!.notifications),
        });
      }
      // Emails. The unrestricted predicate re-processed every in-window booking on every run and,
      // because `insertAndEmailNotification` treats a conflicting insert's [null] identifiers as
      // "inserted", re-sent that booking's emails each time (a pre-existing defect, left alone here:
      // that helper is out of T070's scope). The narrowed predicate may therefore send only a
      // subset of the old emails, never one the old code would not have sent (the two bookings
      // that sit exactly inside the 1 ms slack stay candidates while the frozen clock does not
      // move, so their repeats are exempt) ...
      const previous: Record<string, Run | undefined> = {
        run1: undefined,
        run2: actual['run1']!,
        run3: actual['run2']!,
      };
      for (const run of ['run1', 'run2', 'run3']) {
        const remaining = [...golden[run]!.emails];
        for (const email of actual[run]!.emails) {
          const at = remaining.indexOf(email);
          const slackBooking = email.endsWith('plus24h-1ms') || email.endsWith('plus1h-1ms');
          expect({ run, email, wasSentBefore: at !== -1 || slackBooking }).toEqual({
            run,
            email,
            wasSentBefore: true,
          });
          if (at !== -1) remaining.splice(at, 1);
        }
        // ... and every notification inserted by THIS run still gets its email.
        const before = new Set(
          (previous[run]?.notifications ?? []).map((row) => (row as { key: string }).key),
        );
        const sentEmails = [...actual[run]!.emails];
        for (const row of actual[run]!.notifications as Array<{
          key: string;
          user: string;
          title: string;
        }>) {
          if (before.has(row.key) || row.title === 'seeded') continue;
          const bookingCase = row.key.split(':booking:')[1]?.split(':')[1] ?? '';
          const at = sentEmails.findIndex(
            (email) =>
              email.startsWith(`${row.user} :: ${row.title} :: `) &&
              email.endsWith(`:: ${bookingCase}`),
          );
          expect({ run, key: row.key, emailed: at !== -1 }).toEqual({
            run,
            key: row.key,
            emailed: true,
          });
          sentEmails.splice(at, 1);
        }
      }
      // Steady state sends strictly fewer emails than before (runs 2 and 3 used to repeat them all).
      for (const run of ['run2', 'run3']) {
        expect(actual[run]!.emails.length).toBeLessThan(golden[run]!.emails.length);
      }
    });

    it('costs one candidate statement and no writes once everything has been sent', async () => {
      const frozen = new Date(Math.floor(Date.now() / 1000) * 1000);
      await seedBookings(frozen);
      const email = jest
        .spyOn(app.get(NotificationEmailService), 'send')
        .mockResolvedValue('sent' as never);
      const clock = jest
        .spyOn(service as unknown as { currentTime: () => Date }, 'currentTime')
        .mockReturnValue(frozen);
      await service.dispatchScheduledSessionNotifications();
      // Let real time pass the 1 ms slack so the boundary-adjacent bookings stop being candidates
      // for the "needs nothing" bookings: only bookings that are NOT fully notified may remain.
      clock.mockReturnValue(new Date(frozen.getTime() + 1_000));
      await service.dispatchScheduledSessionNotifications();
      email.mockClear();

      const counter = new StatementCounter(dataSource);
      counter.start();
      await service.dispatchScheduledSessionNotifications();
      counter.stop();
      email.mockRestore();
      clock.mockRestore();

      const statements = counter.statements();
      const writes = statements.filter(
        (statement) =>
          statement.sql.startsWith('INSERT') ||
          statement.sql.startsWith('START TRANSACTION') ||
          statement.sql.startsWith('UPDATE'),
      );
      // The cluster-wide cron lock (CronSingleRunner) costs a try-lock and an unlock on its own
      // connection; besides those: candidate query + cancelled-booking query, and nothing else.
      const isLock = (sql: string) => /pg_(try_)?advisory_(un)?lock/.test(sql);
      expect(statements.filter((statement) => isLock(statement.sql))).toHaveLength(2);
      expect(
        statements
          .filter((statement) => !isLock(statement.sql))
          .map((statement) => statement.sql.slice(0, 6)),
      ).toEqual(['SELECT', 'SELECT']);
      expect(writes).toEqual([]);
    });
  });
});
