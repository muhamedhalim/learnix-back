import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource, EntityManager } from 'typeorm';

import type { MailService } from '../mail/mail.service';
import { ItemType, type Order, type Payment } from '../payments/entities';
import { LessonSessionBookingStatus } from './entities/lesson-session-booking-status.enum';
import type { LessonSessionBooking } from './entities/lesson-session-booking.entity';
import { ScheduledLessonSessionStatus } from './entities/scheduled-lesson-session-status.enum';
import type { ScheduledLessonSession } from './entities/scheduled-lesson-session.entity';
import { LessonSessionsService } from './lesson-sessions.service';

describe('LessonSessionsService booking lifecycle', () => {
  const service = new LessonSessionsService(
    {} as DataSource,
    { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
    { send: jest.fn() } as unknown as MailService,
  );

  const futureSession = (status = ScheduledLessonSessionStatus.SCHEDULED) =>
    ({
      id: 'session-1',
      lesson_id: 'lesson-1',
      start_at: new Date(Date.now() + 3 * 60 * 60_000),
      end_at: new Date(Date.now() + 4 * 60 * 60_000),
      status,
      meeting_url: 'https://meet.example.test/one-to-one',
      lesson: { id: 'lesson-1', is_group: false },
    }) as ScheduledLessonSession;

  const booking = (overrides: Partial<LessonSessionBooking> = {}) =>
    ({
      id: 'booking-1',
      scheduled_session_id: 'session-1',
      student_id: 'student-1',
      order_id: 'order-1',
      payment_id: 'payment-1',
      status: LessonSessionBookingStatus.HELD,
      hold_expires_at: new Date(Date.now() + 10 * 60_000),
      price_minor_snapshot: 50_000,
      currency: 'EGP',
      session: futureSession(),
      ...overrides,
    }) as LessonSessionBooking;

  const order = {
    id: 'order-1',
    item_type: ItemType.LESSON_SESSION,
    item_id: 'session-1',
    student_id: 'student-1',
    original_amount_minor: 50_000,
    currency: 'EGP',
  } as Order;
  const payment = { id: 'payment-1' } as Payment;

  it('uses the configured booking cutoff when deciding whether a payment window fits', () => {
    const now = new Date('2030-01-01T10:00:00.000Z');
    const start = new Date('2030-01-01T12:00:00.000Z');
    expect(service.canPaymentWindowFit(start, 60, now)).toBe(true);
    expect(service.canPaymentWindowFit(start, 61, now)).toBe(false);
  });

  it('rejects attaching a payment window that extends beyond the booking cutoff', async () => {
    const held = booking({ order_id: null, payment_id: null });
    const manager = {
      findOne: jest.fn().mockResolvedValueOnce(held).mockResolvedValueOnce(held.session),
      save: jest.fn(),
    } as unknown as EntityManager;

    await expect(
      service.attachOrder(
        manager,
        held.id,
        held.student_id,
        order,
        payment,
        new Date(held.session.start_at.getTime()),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('atomically confirms only the booking bound to the matching session order and payment', async () => {
    const held = booking();
    const manager = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(held)
        .mockResolvedValueOnce(held.session)
        .mockResolvedValueOnce(held.session.lesson),
      save: jest.fn().mockImplementation(async (value) => value),
    } as unknown as EntityManager;

    await expect(service.confirmForOrder(manager, order, payment)).resolves.toMatchObject({
      status: LessonSessionBookingStatus.CONFIRMED,
    });
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: LessonSessionBookingStatus.CONFIRMED }),
    );

    const mismatched = booking({ student_id: 'another-student' });
    (manager.findOne as jest.Mock)
      .mockResolvedValueOnce(mismatched)
      .mockResolvedValueOnce(mismatched.session)
      .mockResolvedValueOnce(mismatched.session.lesson);
    await expect(service.confirmForOrder(manager, order, payment)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('keeps a normal fully-refunded future slot scheduled but closes a teacher-cancelled slot', async () => {
    const normal = booking({ status: LessonSessionBookingStatus.CONFIRMED });
    const manager = {
      findOne: jest.fn().mockResolvedValueOnce(normal).mockResolvedValueOnce(normal.session),
      save: jest.fn().mockImplementation(async (value) => value),
    } as unknown as EntityManager;

    await service.refundForOrder(manager, order.id);
    expect(normal.status).toBe(LessonSessionBookingStatus.REFUNDED);
    expect(normal.session.status).toBe(ScheduledLessonSessionStatus.SCHEDULED);

    const cancellation = booking({
      status: LessonSessionBookingStatus.CONFIRMED,
      session: futureSession(ScheduledLessonSessionStatus.CANCELLATION_PENDING),
    });
    (manager.findOne as jest.Mock)
      .mockResolvedValueOnce(cancellation)
      .mockResolvedValueOnce(cancellation.session);
    await service.refundForOrder(manager, order.id);
    expect(cancellation.session.status).toBe(ScheduledLessonSessionStatus.CANCELLED);
  });

  it('never returns a meeting URL to an unconfirmed student booking', () => {
    const held = booking({ order_id: null, payment_id: null });
    const serialize = (
      service as unknown as {
        toStudentBooking: (
          value: LessonSessionBooking,
          session: ScheduledLessonSession,
        ) => { session: { meeting_url: string | null } };
      }
    ).toStudentBooking.bind(service);

    expect(serialize(held, held.session).session.meeting_url).toBeNull();
    held.status = LessonSessionBookingStatus.CONFIRMED;
    expect(serialize(held, held.session).session.meeting_url).toBe(
      'https://meet.example.test/one-to-one',
    );
  });

  it('catches up reminder windows after scheduler downtime without double-sending both reminders', async () => {
    const oneHourBooking = booking({
      status: LessonSessionBookingStatus.CONFIRMED,
      session: {
        ...futureSession(),
        start_at: new Date(Date.now() + 30 * 60_000),
      } as ScheduledLessonSession,
    });
    const query = {
      innerJoinAndSelect: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      getMany: jest.fn().mockResolvedValueOnce([oneHourBooking]).mockResolvedValueOnce([]),
    };
    for (const method of ['innerJoinAndSelect', 'where', 'andWhere'] as const) {
      query[method].mockReturnValue(query);
    }
    const recoveryService = new LessonSessionsService(
      {
        getRepository: jest.fn().mockReturnValue({
          createQueryBuilder: jest.fn().mockReturnValue(query),
        }),
      } as unknown as DataSource,
      { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
      { send: jest.fn() } as unknown as MailService,
    );
    const notify = jest
      .spyOn(
        recoveryService as unknown as {
          notifyBookingEvent: (id: string, event: string, value: LessonSessionBooking) => Promise<void>;
        },
        'notifyBookingEvent',
      )
      .mockResolvedValue(undefined);

    await recoveryService.dispatchScheduledSessionNotifications();

    expect(notify).toHaveBeenCalledWith(oneHourBooking.id, 'confirmed', oneHourBooking);
    expect(notify).toHaveBeenCalledWith(oneHourBooking.id, 'reminder_1h', oneHourBooking);
    expect(notify).not.toHaveBeenCalledWith(oneHourBooking.id, 'reminder_24h', oneHourBooking);
  });
});
