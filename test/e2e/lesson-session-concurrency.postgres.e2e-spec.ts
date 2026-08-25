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
          paymob_order_id: null,
          paymob_transaction_id: null,
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
      dataSource.getRepository(LessonSessionBooking).findOneByOrFail({ order_id: purchaseA.order.id }),
    ).resolves.toMatchObject({ status: LessonSessionBookingStatus.REFUNDED });
    await expect(
      dataSource.getRepository(LessonSessionBooking).findOneByOrFail({ order_id: purchaseB.order.id }),
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
});
