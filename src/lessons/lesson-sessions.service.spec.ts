import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { DataSource, EntityManager } from 'typeorm';

import type { MailService } from '../mail/mail.service';
import { ItemType, type Order, type Payment } from '../payments/entities';
import { NoopQueue } from '../queues/noop-queue';
import { JOB_TYPES } from '../queues/queues.constants';
import { User } from '../users/entities/user.entity';
import type { Lesson } from './entities/lesson.entity';
import { LessonSessionBookingStatus } from './entities/lesson-session-booking-status.enum';
import type { LessonSessionBooking } from './entities/lesson-session-booking.entity';
import { MeetingCreationStatus } from './entities/meeting-creation-status.enum';
import { MeetingProvider } from './entities/meeting-provider.enum';
import { ScheduledLessonSessionStatus } from './entities/scheduled-lesson-session-status.enum';
import type { ScheduledLessonSession } from './entities/scheduled-lesson-session.entity';
import { TeacherMeetingAccount } from './entities/teacher-meeting-account.entity';
import { TeacherMeetingAccountStatus } from './entities/teacher-meeting-account-status.enum';
import { LessonSessionsService } from './lesson-sessions.service';
import type { MeetingAccountsService } from './meetings/meeting-accounts.service';
import type { MeetingProviderRegistry } from './meetings/meeting-provider-registry.service';
import { RetryableProviderError } from './meetings/providers/provider-errors';

function noopMeetingDeps(): {
  registry: MeetingProviderRegistry;
  accounts: MeetingAccountsService;
  queue: Queue;
} {
  return {
    registry: { find: jest.fn().mockReturnValue(null) } as unknown as MeetingProviderRegistry,
    accounts: {
      findConnectedAccount: jest.fn().mockResolvedValue(null),
      getUsableAccount: jest.fn().mockResolvedValue(null),
    } as unknown as MeetingAccountsService,
    queue: { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue,
  };
}

describe('LessonSessionsService booking lifecycle', () => {
  const meetingDeps = noopMeetingDeps();
  const service = new LessonSessionsService(
    {} as DataSource,
    { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
    { send: jest.fn() } as unknown as MailService,
    meetingDeps.registry,
    meetingDeps.accounts,
    meetingDeps.queue,
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
    const recoveryDeps = noopMeetingDeps();
    const recoveryService = new LessonSessionsService(
      {
        getRepository: jest.fn().mockReturnValue({
          createQueryBuilder: jest.fn().mockReturnValue(query),
        }),
      } as unknown as DataSource,
      { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
      { send: jest.fn() } as unknown as MailService,
      recoveryDeps.registry,
      recoveryDeps.accounts,
      recoveryDeps.queue,
    );
    const notify = jest
      .spyOn(
        recoveryService as unknown as {
          notifyBookingEvent: (
            id: string,
            event: string,
            value: LessonSessionBooking,
          ) => Promise<void>;
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

describe('LessonSessionsService meeting generation (Phase 5)', () => {
  const teacherId = 'teacher-1';
  const lessonId = 'lesson-1';
  const sessionId = 'session-1';

  function chainableQuery(methods: string[]): Record<string, jest.Mock> {
    const query: Record<string, jest.Mock> = {};
    for (const method of methods) query[method] = jest.fn(() => query);
    return query;
  }

  function individualLesson(): Lesson {
    return { id: lessonId, teacher_id: teacherId, is_group: false, duration: 1800 } as Lesson;
  }

  function scheduledSession(
    overrides: Partial<ScheduledLessonSession> = {},
  ): ScheduledLessonSession {
    return {
      id: sessionId,
      lesson_id: lessonId,
      teacher_id: teacherId,
      start_at: new Date(Date.now() + 3 * 60 * 60_000),
      end_at: new Date(Date.now() + 4 * 60 * 60_000),
      status: ScheduledLessonSessionStatus.SCHEDULED,
      meeting_url: null,
      meeting_provider: null,
      meeting_status: MeetingCreationStatus.NOT_REQUESTED,
      meeting_account_id: null,
      external_meeting_id: null,
      meeting_host_url: null,
      meeting_passcode: null,
      meeting_error: null,
      meeting_attempts: 0,
      meeting_requested_at: null,
      meeting_ready_at: null,
      bookings: [],
      lesson: individualLesson(),
      ...overrides,
    } as ScheduledLessonSession;
  }

  function configuredClient(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      name: MeetingProvider.GOOGLE_MEET,
      isConfigured: () => true,
      createMeeting: jest.fn(),
      updateMeeting: jest.fn().mockResolvedValue(undefined),
      deleteMeeting: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  function insertQueryBuilder(
    overrides: Record<string, jest.Mock> = {},
  ): Record<string, jest.Mock> {
    const query: Record<string, jest.Mock> = {
      insert: jest.fn(() => query),
      into: jest.fn(() => query),
      values: jest.fn(() => query),
      orIgnore: jest.fn(() => query),
      returning: jest.fn(() => query),
      execute: jest.fn().mockResolvedValue({ identifiers: [{ id: 'notification-1' }] }),
      ...overrides,
    };
    return query;
  }

  function buildService(
    overrides: {
      registryFind?: jest.Mock;
      findConnectedAccount?: jest.Mock;
      getUsableAccount?: jest.Mock;
      manager?: Record<string, jest.Mock>;
      repository?: Record<string, jest.Mock>;
      repositoriesByEntity?: Map<unknown, Record<string, jest.Mock>>;
      queryBuilder?: Record<string, jest.Mock>;
      config?: Record<string, string>;
    } = {},
  ) {
    const manager: Record<string, jest.Mock> = {
      findOne: jest.fn(),
      save: jest.fn(async (a: unknown, b?: unknown) => (b === undefined ? a : b)),
      create: jest.fn((_cls: unknown, value: unknown) => value),
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn(),
      ...overrides.manager,
    };
    const repository: Record<string, jest.Mock> = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(async (value: unknown) => value),
      ...overrides.repository,
    };
    const queryBuilder = overrides.queryBuilder ?? insertQueryBuilder();
    const dataSource = {
      transaction: jest.fn(async (fn: (m: typeof manager) => unknown) => await fn(manager)),
      getRepository: jest.fn(
        (entity: unknown) => overrides.repositoriesByEntity?.get(entity) ?? repository,
      ),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    } as unknown as DataSource;
    const registry = {
      find: overrides.registryFind ?? jest.fn().mockReturnValue(null),
    } as unknown as MeetingProviderRegistry;
    const accounts = {
      findConnectedAccount: overrides.findConnectedAccount ?? jest.fn().mockResolvedValue(null),
      getUsableAccount: overrides.getUsableAccount ?? jest.fn().mockResolvedValue(null),
    } as unknown as MeetingAccountsService;
    const queue = { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue;
    const config = { ...overrides.config };
    const service = new LessonSessionsService(
      dataSource,
      { get: jest.fn((key: string) => config[key]) } as unknown as ConfigService,
      { send: jest.fn() } as unknown as MailService,
      registry,
      accounts,
      queue,
    );
    return { service, manager, repository, registry, accounts, queue, dataSource, queryBuilder };
  }

  it('creating a slot with a selected provider stays not_requested, sets no meeting_url, and enqueues nothing', async () => {
    const overlapQuery = chainableQuery(['where', 'andWhere']);
    overlapQuery['getExists'] = jest.fn().mockResolvedValue(false);
    const { service, manager, queue } = buildService({
      manager: {
        getRepository: jest
          .fn()
          .mockReturnValue({ createQueryBuilder: jest.fn().mockReturnValue(overlapQuery) }),
      },
    });

    const [created] = await service.createManyWithManager(
      manager as never,
      individualLesson(),
      teacherId,
      [
        {
          start_at: new Date(Date.now() + 3600_000).toISOString(),
          meeting_provider: MeetingProvider.GOOGLE_MEET,
        },
      ],
    );

    expect(created).toMatchObject({
      meeting_status: MeetingCreationStatus.NOT_REQUESTED,
      meeting_url: null,
      meeting_provider: MeetingProvider.GOOGLE_MEET,
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a manual meeting_url is ready immediately and forces provider=manual', async () => {
    const overlapQuery = chainableQuery(['where', 'andWhere']);
    overlapQuery['getExists'] = jest.fn().mockResolvedValue(false);
    const { service, manager } = buildService({
      manager: {
        getRepository: jest
          .fn()
          .mockReturnValue({ createQueryBuilder: jest.fn().mockReturnValue(overlapQuery) }),
      },
    });

    const [created] = await service.createManyWithManager(
      manager as never,
      individualLesson(),
      teacherId,
      [
        {
          start_at: new Date(Date.now() + 3600_000).toISOString(),
          meeting_url: 'https://meet.example.test/manual',
        },
      ],
    );

    expect(created).toMatchObject({
      meeting_status: MeetingCreationStatus.READY,
      meeting_url: 'https://meet.example.test/manual',
      meeting_provider: MeetingProvider.MANUAL,
    });
  });

  it('rejects generation for a group lesson at precondition 2', async () => {
    const { service, manager } = buildService();
    manager.findOne
      .mockResolvedValueOnce(scheduledSession())
      .mockResolvedValueOnce({ id: lessonId, teacher_id: teacherId, is_group: true });

    await expect(
      service.requestMeetingGeneration(lessonId, sessionId, teacherId, MeetingProvider.GOOGLE_MEET),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects generation with 409 MEETING_ACCOUNT_NOT_CONNECTED when no account is connected (R-11)', async () => {
    const { service, manager } = buildService({
      registryFind: jest.fn().mockReturnValue(configuredClient()),
      findConnectedAccount: jest.fn().mockResolvedValue(null),
    });
    manager.findOne
      .mockResolvedValueOnce(scheduledSession())
      .mockResolvedValueOnce(individualLesson());

    await expect(
      service.requestMeetingGeneration(lessonId, sessionId, teacherId, MeetingProvider.GOOGLE_MEET),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'MEETING_ACCOUNT_NOT_CONNECTED',
        provider: MeetingProvider.GOOGLE_MEET,
      }),
    });
  });

  it('rejects a second concurrent Generate while one is already pending (R-16)', async () => {
    const { service, manager } = buildService({
      registryFind: jest.fn().mockReturnValue(configuredClient()),
      findConnectedAccount: jest.fn().mockResolvedValue({ id: 'account-1' }),
    });
    manager.findOne
      .mockResolvedValueOnce(scheduledSession({ meeting_status: MeetingCreationStatus.PENDING }))
      .mockResolvedValueOnce(individualLesson());

    await expect(
      service.requestMeetingGeneration(lessonId, sessionId, teacherId, MeetingProvider.GOOGLE_MEET),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects when the appointment already has a ready meeting', async () => {
    const { service, manager } = buildService({
      registryFind: jest.fn().mockReturnValue(configuredClient()),
      findConnectedAccount: jest.fn().mockResolvedValue({ id: 'account-1' }),
    });
    manager.findOne
      .mockResolvedValueOnce(scheduledSession({ meeting_status: MeetingCreationStatus.READY }))
      .mockResolvedValueOnce(individualLesson());

    await expect(
      service.requestMeetingGeneration(lessonId, sessionId, teacherId, MeetingProvider.GOOGLE_MEET),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('accepts Generate on a not_requested slot and enqueues exactly one deduplicated job (AD-9)', async () => {
    const { service, manager, queue } = buildService({
      registryFind: jest.fn().mockReturnValue(configuredClient()),
      findConnectedAccount: jest.fn().mockResolvedValue({ id: 'account-1' }),
    });
    manager.findOne
      .mockResolvedValueOnce(scheduledSession())
      .mockResolvedValueOnce(individualLesson());

    const result = await service.requestMeetingGeneration(
      lessonId,
      sessionId,
      teacherId,
      MeetingProvider.GOOGLE_MEET,
    );

    expect(result).toMatchObject({ meeting_status: MeetingCreationStatus.PENDING });
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      { sessionId },
      { jobId: expect.stringMatching(new RegExp(`^meeting\\.provision\\.${sessionId}\\.\\d+$`)) },
    );
  });

  it('a Retry after a failed attempt enqueues a DIFFERENT job id so BullMQ cannot drop it as a duplicate', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const jobIds: string[] = [];
      for (const failed of [false, true]) {
        const { service, manager, queue } = buildService({
          registryFind: jest.fn().mockReturnValue(configuredClient()),
          findConnectedAccount: jest.fn().mockResolvedValue({ id: 'account-1' }),
        });
        manager.findOne
          .mockResolvedValueOnce(
            scheduledSession(failed ? { meeting_status: MeetingCreationStatus.FAILED } : {}),
          )
          .mockResolvedValueOnce(individualLesson());
        await service.requestMeetingGeneration(
          lessonId,
          sessionId,
          teacherId,
          MeetingProvider.GOOGLE_MEET,
        );
        jobIds.push((queue.add as jest.Mock).mock.calls[0][2].jobId as string);
        jest.advanceTimersByTime(1000);
      }
      expect(new Set(jobIds).size).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('provisions inline instead of enqueueing when the queue is a NoopQueue (no Redis)', async () => {
    const { service, manager, queue, repository } = buildService({
      registryFind: jest.fn().mockReturnValue(configuredClient()),
      findConnectedAccount: jest.fn().mockResolvedValue({ id: 'account-1' }),
    });
    manager.findOne
      .mockResolvedValueOnce(scheduledSession())
      .mockResolvedValueOnce(individualLesson());
    Object.setPrototypeOf(queue, NoopQueue.prototype);
    const provision = jest.spyOn(service, 'provisionMeeting').mockResolvedValue(undefined);
    repository['findOne'].mockResolvedValue(
      scheduledSession({ meeting_status: MeetingCreationStatus.READY }),
    );

    const result = await service.requestMeetingGeneration(
      lessonId,
      sessionId,
      teacherId,
      MeetingProvider.GOOGLE_MEET,
    );

    expect(provision).toHaveBeenCalledWith(sessionId);
    expect(queue.add).not.toHaveBeenCalled();
    expect(result).toMatchObject({ meeting_status: MeetingCreationStatus.READY });
  });

  it('accepts Retry on a failed slot (negative test 4)', async () => {
    const { service, manager, queue } = buildService({
      registryFind: jest.fn().mockReturnValue(configuredClient()),
      findConnectedAccount: jest.fn().mockResolvedValue({ id: 'account-1' }),
    });
    manager.findOne
      .mockResolvedValueOnce(
        scheduledSession({ meeting_status: MeetingCreationStatus.FAILED, meeting_error: 'boom' }),
      )
      .mockResolvedValueOnce(individualLesson());

    const result = await service.requestMeetingGeneration(
      lessonId,
      sessionId,
      teacherId,
      MeetingProvider.GOOGLE_MEET,
    );

    expect(result).toMatchObject({
      meeting_status: MeetingCreationStatus.PENDING,
      meeting_error: null,
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('clearMeetingGeneration refuses to remove a meeting once the booking is confirmed', async () => {
    const { service, manager } = buildService();
    manager.findOne
      .mockResolvedValueOnce(scheduledSession({ meeting_status: MeetingCreationStatus.READY }))
      .mockResolvedValueOnce({ id: 'booking-1', status: LessonSessionBookingStatus.CONFIRMED });
    manager['getRepository'] = jest.fn().mockReturnValue({
      createQueryBuilder: jest.fn().mockReturnValue(
        (() => {
          const q = chainableQuery(['where', 'andWhere']);
          q['getOne'] = jest
            .fn()
            .mockResolvedValue({ status: LessonSessionBookingStatus.CONFIRMED });
          return q;
        })(),
      ),
    });

    await expect(
      service.clearMeetingGeneration(lessonId, sessionId, teacherId),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('clearMeetingGeneration resets a ready slot and best-effort deletes it at the provider', async () => {
    const client = configuredClient();
    const overlapQuery = chainableQuery(['where', 'andWhere']);
    overlapQuery['getOne'] = jest.fn().mockResolvedValue(null);
    const { service, manager, accounts } = buildService({
      registryFind: jest.fn().mockReturnValue(client),
      getUsableAccount: jest
        .fn()
        .mockResolvedValue({ id: 'account-1', access_token_encrypted: 'token' }),
      manager: {
        getRepository: jest
          .fn()
          .mockReturnValue({ createQueryBuilder: jest.fn().mockReturnValue(overlapQuery) }),
      },
    });
    manager.findOne.mockResolvedValueOnce(
      scheduledSession({
        meeting_status: MeetingCreationStatus.READY,
        meeting_provider: MeetingProvider.GOOGLE_MEET,
        external_meeting_id: 'ext-1',
        meeting_url: 'https://meet.google.com/abc',
      }),
    );

    const result = await service.clearMeetingGeneration(lessonId, sessionId, teacherId);

    expect(result).toMatchObject({
      meeting_status: MeetingCreationStatus.NOT_REQUESTED,
      meeting_url: null,
    });
    expect(accounts.getUsableAccount).toHaveBeenCalledWith(teacherId, MeetingProvider.GOOGLE_MEET);
    expect(client.deleteMeeting).toHaveBeenCalledWith('token', 'ext-1');
  });

  it('provisionMeeting is a no-op when the row is no longer pending (duplicate job, AD-8)', async () => {
    const { service, repository } = buildService({
      repository: {
        update: jest.fn().mockResolvedValue({ affected: 0 }),
        findOne: jest.fn(),
        save: jest.fn(),
      },
    });

    await service.provisionMeeting(sessionId);

    expect(repository['findOne']).not.toHaveBeenCalled();
  });

  it('provisionMeeting creates the meeting and marks the session ready', async () => {
    const client = configuredClient({
      createMeeting: jest.fn().mockResolvedValue({
        externalId: 'ext-1',
        joinUrl: 'https://meet.google.com/abc-defg',
        hostUrl: 'https://calendar.google.com/event?eid=1',
        passcode: null,
      }),
    });
    const { service, repository } = buildService({
      registryFind: jest.fn().mockReturnValue(client),
      getUsableAccount: jest
        .fn()
        .mockResolvedValue({ id: 'account-1', access_token_encrypted: 'token' }),
      repository: {
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        findOne: jest.fn().mockResolvedValue(
          scheduledSession({
            meeting_status: MeetingCreationStatus.CREATING,
            meeting_provider: MeetingProvider.GOOGLE_MEET,
          }),
        ),
        save: jest.fn(async (value: unknown) => value),
      },
    });

    await service.provisionMeeting(sessionId);

    expect(repository['save']).toHaveBeenCalledWith(
      expect.objectContaining({
        meeting_status: MeetingCreationStatus.READY,
        meeting_url: 'https://meet.google.com/abc-defg',
        external_meeting_id: 'ext-1',
      }),
    );
  });

  it('provisionMeeting marks the session failed when the provider call throws', async () => {
    const client = configuredClient({
      createMeeting: jest.fn().mockRejectedValue(new Error('provider down')),
    });
    const { service, repository } = buildService({
      registryFind: jest.fn().mockReturnValue(client),
      getUsableAccount: jest
        .fn()
        .mockResolvedValue({ id: 'account-1', access_token_encrypted: 'token' }),
      repository: {
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        findOne: jest.fn().mockResolvedValue(
          scheduledSession({
            meeting_status: MeetingCreationStatus.CREATING,
            meeting_provider: MeetingProvider.GOOGLE_MEET,
          }),
        ),
        save: jest.fn(async (value: unknown) => value),
      },
    });

    await service.provisionMeeting(sessionId);

    expect(repository['save']).toHaveBeenCalledWith(
      expect.objectContaining({
        meeting_status: MeetingCreationStatus.FAILED,
        meeting_error: 'provider down',
      }),
    );
  });

  function teacherFixture(overrides: Partial<User> = {}): User {
    return {
      id: teacherId,
      email: 'teacher@example.test',
      name: 'Teacher One',
      preferred_language: 'en',
      ...overrides,
    } as User;
  }

  it('provisionMeeting fires a meeting_creation_failed notification, deduped by attempt (Phase 8)', async () => {
    const client = configuredClient({
      createMeeting: jest.fn().mockRejectedValue(new Error('provider down')),
    });
    const userRepo = { findOne: jest.fn().mockResolvedValue(teacherFixture()) };
    const { service, queryBuilder } = buildService({
      registryFind: jest.fn().mockReturnValue(client),
      getUsableAccount: jest
        .fn()
        .mockResolvedValue({ id: 'account-1', access_token_encrypted: 'token' }),
      repository: {
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        findOne: jest.fn().mockResolvedValue(
          scheduledSession({
            meeting_status: MeetingCreationStatus.CREATING,
            meeting_provider: MeetingProvider.GOOGLE_MEET,
            meeting_attempts: 0,
          }),
        ),
        save: jest.fn(async (value: unknown) => value),
      },
      repositoriesByEntity: new Map([[User, userRepo]]),
    });

    await service.provisionMeeting(sessionId);

    expect(queryBuilder['values']).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupe_key: `lesson-session:${sessionId}:meeting_failed:1`,
        user_id: teacherId,
        source_event: 'lesson_session_meeting_creation_failed',
      }),
    );
  });

  it('provisionMeeting also fires meeting_account_expired when getUsableAccount just expired the account (Phase 8)', async () => {
    const client = configuredClient();
    const userRepo = { findOne: jest.fn().mockResolvedValue(teacherFixture()) };
    const accountRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'account-1',
        teacher_id: teacherId,
        provider: MeetingProvider.GOOGLE_MEET,
        status: TeacherMeetingAccountStatus.EXPIRED,
      } as TeacherMeetingAccount),
    };
    const { service, queryBuilder } = buildService({
      registryFind: jest.fn().mockReturnValue(client),
      // null simulates getUsableAccount having just flipped a CONNECTED
      // account to EXPIRED while servicing this call.
      getUsableAccount: jest.fn().mockResolvedValue(null),
      repository: {
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        findOne: jest.fn().mockResolvedValue(
          scheduledSession({
            meeting_status: MeetingCreationStatus.CREATING,
            meeting_provider: MeetingProvider.GOOGLE_MEET,
            meeting_attempts: 0,
          }),
        ),
        save: jest.fn(async (value: unknown) => value),
      },
      repositoriesByEntity: new Map([
        [User, userRepo],
        [TeacherMeetingAccount, accountRepo],
      ]),
    });

    await service.provisionMeeting(sessionId);

    const dayBucket = new Date().toISOString().slice(0, 10);
    expect(queryBuilder['values']).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupe_key: `meeting-account:account-1:expired:${dayBucket}`,
        source_event: 'meeting_account_expired',
      }),
    );
    expect(queryBuilder['values']).toHaveBeenCalledWith(
      expect.objectContaining({ source_event: 'lesson_session_meeting_creation_failed' }),
    );
  });

  it('sweepStuckMeetingProvisioning returns a wedged creating row to failed and notifies the teacher (Phase 8)', async () => {
    const userRepo = { findOne: jest.fn().mockResolvedValue(teacherFixture()) };
    const stuckSession = scheduledSession({
      meeting_status: MeetingCreationStatus.CREATING,
      meeting_provider: MeetingProvider.GOOGLE_MEET,
      meeting_requested_at: new Date(Date.now() - 20 * 60_000),
      meeting_attempts: 0,
    });
    const { service, repository, queryBuilder } = buildService({
      repository: {
        find: jest.fn().mockResolvedValue([stuckSession]),
        save: jest.fn(async (value: unknown) => value),
      },
      repositoriesByEntity: new Map([[User, userRepo]]),
    });

    const count = await service.sweepStuckMeetingProvisioning();

    expect(count).toBe(1);
    expect(repository['save']).toHaveBeenCalledWith(
      expect.objectContaining({
        meeting_status: MeetingCreationStatus.FAILED,
        meeting_error: 'Meeting creation timed out',
      }),
    );
    expect(queryBuilder['values']).toHaveBeenCalledWith(
      expect.objectContaining({ source_event: 'lesson_session_meeting_creation_failed' }),
    );
  });

  it('sweep re-enqueues a recently stale pending row once, with a stable recover job id', async () => {
    const requestedAt = new Date(Date.now() - 20 * 60_000);
    const pending = scheduledSession({
      meeting_status: MeetingCreationStatus.PENDING,
      meeting_provider: MeetingProvider.GOOGLE_MEET,
      meeting_requested_at: requestedAt,
    });
    const { service, repository, queue } = buildService({
      repository: { find: jest.fn().mockResolvedValue([pending]) },
    });

    await service.sweepStuckMeetingProvisioning();
    await service.sweepStuckMeetingProvisioning();

    const ids = (queue.add as jest.Mock).mock.calls.map((call) => call[2].jobId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe(`meeting.provision.${pending.id}.${requestedAt.getTime()}.recover`);
    expect(repository['save']).not.toHaveBeenCalled();
  });

  it('sweep fails a pending row that never started after twice the stuck window', async () => {
    const pending = scheduledSession({
      meeting_status: MeetingCreationStatus.PENDING,
      meeting_provider: MeetingProvider.GOOGLE_MEET,
      meeting_requested_at: new Date(Date.now() - 40 * 60_000),
      meeting_attempts: 0,
    });
    const { service, repository, queue } = buildService({
      repository: { find: jest.fn().mockResolvedValue([pending]) },
      repositoriesByEntity: new Map([[User, { findOne: jest.fn().mockResolvedValue(teacherFixture()) }]]),
    });

    await service.sweepStuckMeetingProvisioning();

    expect(queue.add).not.toHaveBeenCalled();
    expect(repository['save']).toHaveBeenCalledWith(
      expect.objectContaining({
        meeting_status: MeetingCreationStatus.FAILED,
        meeting_error: 'Meeting creation did not start',
      }),
    );
  });

  describe('provider lifecycle (Unit B)', () => {
    const readySession = (overrides: Partial<ScheduledLessonSession> = {}) =>
      scheduledSession({
        meeting_status: MeetingCreationStatus.READY,
        meeting_provider: MeetingProvider.GOOGLE_MEET,
        external_meeting_id: 'ext-1',
        meeting_url: 'https://meet.google.com/abc',
        ...overrides,
      });

    const provisionSetup = (createMeeting: jest.Mock, overrides: Partial<ScheduledLessonSession> = {}) => {
      const client = configuredClient({ createMeeting });
      return buildService({
        registryFind: jest.fn().mockReturnValue(client),
        getUsableAccount: jest.fn().mockResolvedValue({ id: 'account-1', access_token_encrypted: 'token' }),
        repository: {
          update: jest.fn().mockResolvedValue({ affected: 1 }),
          findOne: jest.fn().mockResolvedValue(
            scheduledSession({
              meeting_status: MeetingCreationStatus.CREATING,
              meeting_provider: MeetingProvider.GOOGLE_MEET,
              meeting_requested_at: new Date('2026-01-01T00:00:00.000Z'),
              ...overrides,
            }),
          ),
          save: jest.fn(async (value: unknown) => value),
        },
        repositoriesByEntity: new Map([[User, { findOne: jest.fn().mockResolvedValue(teacherFixture()) }]]),
      });
    };

    it('provisionMeeting sends a per-request idempotency key (session id + request time)', async () => {
      const createMeeting = jest.fn().mockResolvedValue({
        externalId: 'ext-1',
        joinUrl: 'https://meet.google.com/abc',
      });
      const { service } = provisionSetup(createMeeting);

      await service.provisionMeeting(sessionId);

      expect(createMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: `${sessionId}-${String(new Date('2026-01-01T00:00:00.000Z').getTime())}`,
        }),
      );
    });

    it('a transient provider failure before the final attempt returns the row to pending and rethrows for BullMQ', async () => {
      const transient = new RetryableProviderError('meeting creation failed with status 503', null, 503);
      const { service, repository, queryBuilder } = provisionSetup(jest.fn().mockRejectedValue(transient));

      await expect(service.provisionMeeting(sessionId, { finalAttempt: false })).rejects.toBe(transient);

      expect(repository['save']).toHaveBeenCalledWith(
        expect.objectContaining({ meeting_status: MeetingCreationStatus.PENDING }),
      );
      expect(queryBuilder['values']).not.toHaveBeenCalled();
    });

    it('a transient provider failure on the final attempt is recorded as failed with a retry hint and notified', async () => {
      const transient = new RetryableProviderError('meeting creation failed with status 429', 5000, 429);
      const { service, repository, queryBuilder } = provisionSetup(jest.fn().mockRejectedValue(transient));

      await service.provisionMeeting(sessionId, { finalAttempt: true });

      expect(repository['save']).toHaveBeenCalledWith(
        expect.objectContaining({
          meeting_status: MeetingCreationStatus.FAILED,
          meeting_error: 'The meeting provider is temporarily unavailable — please retry',
          meeting_attempts: 1,
        }),
      );
      expect(queryBuilder['values']).toHaveBeenCalled();
    });

    it('a transient failure while refreshing the account token also retries instead of failing', async () => {
      const transient = new RetryableProviderError('token refresh failed with status 502', null, 502);
      const { service, repository } = buildService({
        registryFind: jest.fn().mockReturnValue(configuredClient()),
        getUsableAccount: jest.fn().mockRejectedValue(transient),
        repository: {
          update: jest.fn().mockResolvedValue({ affected: 1 }),
          findOne: jest.fn().mockResolvedValue(
            scheduledSession({
              meeting_status: MeetingCreationStatus.CREATING,
              meeting_provider: MeetingProvider.GOOGLE_MEET,
            }),
          ),
          save: jest.fn(async (value: unknown) => value),
        },
      });

      await expect(service.provisionMeeting(sessionId, { finalAttempt: false })).rejects.toBe(transient);
      expect(repository['save']).toHaveBeenCalledWith(
        expect.objectContaining({ meeting_status: MeetingCreationStatus.PENDING }),
      );
    });

    it('syncMeetingTime pushes the slot\'s current times to the provider meeting', async () => {
      const updateMeeting = jest.fn().mockResolvedValue(undefined);
      const session = readySession();
      const { service } = buildService({
        registryFind: jest.fn().mockReturnValue(configuredClient({ updateMeeting })),
        getUsableAccount: jest.fn().mockResolvedValue({ id: 'account-1', access_token_encrypted: 'token' }),
        repository: { findOne: jest.fn().mockResolvedValue(session) },
      });

      await service.syncMeetingTime(sessionId);

      expect(updateMeeting).toHaveBeenCalledWith(
        'token',
        'ext-1',
        expect.objectContaining({ startAt: session.start_at, endAt: session.end_at }),
      );
    });

    it('syncMeetingTime keeps the meeting ready and flags meeting_error when the provider update fails', async () => {
      const updateMeeting = jest.fn().mockRejectedValue(new Error('boom'));
      const session = readySession();
      const { service, repository } = buildService({
        registryFind: jest.fn().mockReturnValue(configuredClient({ updateMeeting })),
        getUsableAccount: jest.fn().mockResolvedValue({ id: 'account-1', access_token_encrypted: 'token' }),
        repository: { findOne: jest.fn().mockResolvedValue(session), save: jest.fn(async (v: unknown) => v) },
      });

      await service.syncMeetingTime(sessionId);

      expect(repository['save']).toHaveBeenCalledWith(
        expect.objectContaining({
          meeting_status: MeetingCreationStatus.READY,
          meeting_error: 'The meeting time could not be updated at the provider',
        }),
      );
    });

    it('syncMeetingTime rethrows a transient failure before the final attempt so BullMQ retries', async () => {
      const transient = new RetryableProviderError('meeting update failed with status 503', null, 503);
      const { service } = buildService({
        registryFind: jest
          .fn()
          .mockReturnValue(configuredClient({ updateMeeting: jest.fn().mockRejectedValue(transient) })),
        getUsableAccount: jest.fn().mockResolvedValue({ id: 'account-1', access_token_encrypted: 'token' }),
        repository: { findOne: jest.fn().mockResolvedValue(readySession()) },
      });

      await expect(service.syncMeetingTime(sessionId, { finalAttempt: false })).rejects.toBe(transient);
    });

    it('syncMeetingTime ignores manual-link and not-ready sessions', async () => {
      const updateMeeting = jest.fn();
      for (const session of [
        readySession({ meeting_provider: MeetingProvider.MANUAL }),
        readySession({ meeting_status: MeetingCreationStatus.FAILED }),
      ]) {
        const { service } = buildService({
          registryFind: jest.fn().mockReturnValue(configuredClient({ updateMeeting })),
          repository: { findOne: jest.fn().mockResolvedValue(session) },
        });
        await service.syncMeetingTime(sessionId);
      }
      expect(updateMeeting).not.toHaveBeenCalled();
    });

    it('update() enqueues a uniquely-identified sync job when a ready provider meeting is rescheduled', async () => {
      const overlap = chainableQuery(['where', 'andWhere']);
      overlap['getExists'] = jest.fn().mockResolvedValue(false);
      overlap['getOne'] = jest.fn().mockResolvedValue(null);
      const { service, manager, queue } = buildService({
        manager: {
          getRepository: jest.fn().mockReturnValue({ createQueryBuilder: jest.fn().mockReturnValue(overlap) }),
        },
      });
      manager.findOne.mockResolvedValueOnce(readySession());
      const start = new Date(Date.now() + 5 * 3600_000);

      await service.update(lessonId, sessionId, teacherId, {
        start_at: start.toISOString(),
        end_at: new Date(start.getTime() + 3600_000).toISOString(),
      });

      expect(queue.add).toHaveBeenCalledWith(
        JOB_TYPES.MEETING.SYNC,
        { sessionId },
        { jobId: expect.stringMatching(new RegExp(`^meeting\\.sync\\.${sessionId}\\.\\d+$`)) },
      );
    });

    it('update() does not enqueue a sync for a manual-link slot', async () => {
      const overlap = chainableQuery(['where', 'andWhere']);
      overlap['getExists'] = jest.fn().mockResolvedValue(false);
      overlap['getOne'] = jest.fn().mockResolvedValue(null);
      const { service, manager, queue } = buildService({
        manager: {
          getRepository: jest.fn().mockReturnValue({ createQueryBuilder: jest.fn().mockReturnValue(overlap) }),
        },
      });
      manager.findOne.mockResolvedValueOnce(
        readySession({ meeting_provider: MeetingProvider.MANUAL, external_meeting_id: null }),
      );
      const start = new Date(Date.now() + 5 * 3600_000);

      await service.update(lessonId, sessionId, teacherId, {
        start_at: start.toISOString(),
        end_at: new Date(start.getTime() + 3600_000).toISOString(),
      });

      expect(queue.add).not.toHaveBeenCalled();
    });

    it('releaseCancelledSessionMeeting deletes the provider meeting and clears the local reference', async () => {
      const deleteMeeting = jest.fn().mockResolvedValue(undefined);
      const session = readySession({ status: ScheduledLessonSessionStatus.CANCELLED });
      const { service, repository } = buildService({
        registryFind: jest.fn().mockReturnValue(configuredClient({ deleteMeeting })),
        getUsableAccount: jest.fn().mockResolvedValue({ id: 'account-1', access_token_encrypted: 'token' }),
        repository: { findOne: jest.fn().mockResolvedValue(session) },
      });

      await expect(service.releaseCancelledSessionMeeting(sessionId)).resolves.toBe(true);

      expect(deleteMeeting).toHaveBeenCalledWith('token', 'ext-1');
      expect(repository['update']).toHaveBeenCalledWith(
        { id: session.id, external_meeting_id: 'ext-1' },
        expect.objectContaining({ external_meeting_id: null, meeting_url: null }),
      );
    });

    it('releaseCancelledSessionMeeting keeps the reference when the teacher has no usable account', async () => {
      const deleteMeeting = jest.fn();
      const session = readySession({ status: ScheduledLessonSessionStatus.CANCELLED });
      const { service, repository } = buildService({
        registryFind: jest.fn().mockReturnValue(configuredClient({ deleteMeeting })),
        getUsableAccount: jest.fn().mockResolvedValue(null),
        repository: { findOne: jest.fn().mockResolvedValue(session) },
      });

      await expect(service.releaseCancelledSessionMeeting(sessionId)).resolves.toBe(false);

      expect(deleteMeeting).not.toHaveBeenCalled();
      expect(repository['update']).not.toHaveBeenCalled();
    });

    it('releaseCancelledSessionMeeting leaves a still-scheduled session alone', async () => {
      const deleteMeeting = jest.fn();
      const { service } = buildService({
        registryFind: jest.fn().mockReturnValue(configuredClient({ deleteMeeting })),
        repository: { findOne: jest.fn().mockResolvedValue(readySession()) },
      });

      await expect(service.releaseCancelledSessionMeeting(sessionId)).resolves.toBe(false);
      expect(deleteMeeting).not.toHaveBeenCalled();
    });

    it('sweepCancelledSessionMeetings releases each recently cancelled provider meeting', async () => {
      const deleteMeeting = jest.fn().mockResolvedValue(undefined);
      const cancelled = readySession({ status: ScheduledLessonSessionStatus.CANCELLED });
      const { service } = buildService({
        registryFind: jest.fn().mockReturnValue(configuredClient({ deleteMeeting })),
        getUsableAccount: jest.fn().mockResolvedValue({ id: 'account-1', access_token_encrypted: 'token' }),
        repository: {
          find: jest.fn().mockResolvedValue([cancelled]),
          findOne: jest.fn().mockResolvedValue(cancelled),
        },
      });

      await expect(service.sweepCancelledSessionMeetings()).resolves.toBe(1);
      expect(deleteMeeting).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Phase 9. `toSafeSession`/`toStudentBooking`/`toPrivilegedSession` are the
 * three shapes every meeting field ultimately flows through — locking in
 * their exact exposure surface here is the regression guard for the "who
 * can see a meeting URL" table in the plan (owner teacher, admin, and only
 * the student whose booking is confirmed; never `meeting_host_url` or
 * `meeting_passcode` outside the teacher/admin view).
 */
describe('LessonSessionsService meeting-URL exposure invariant (Phase 9)', () => {
  const meetingDeps = noopMeetingDeps();
  const service = new LessonSessionsService(
    {} as DataSource,
    { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
    { send: jest.fn() } as unknown as MailService,
    meetingDeps.registry,
    meetingDeps.accounts,
    meetingDeps.queue,
  );

  function accessPrivate<T>(name: string): T {
    return (service as unknown as Record<string, unknown>)[name] as T;
  }

  const fullSession = (overrides: Partial<ScheduledLessonSession> = {}) =>
    ({
      id: 'session-1',
      lesson_id: 'lesson-1',
      start_at: new Date(Date.now() + 3 * 60 * 60_000),
      end_at: new Date(Date.now() + 4 * 60 * 60_000),
      status: ScheduledLessonSessionStatus.SCHEDULED,
      meeting_url: 'https://meet.example.test/one-to-one',
      meeting_provider: MeetingProvider.GOOGLE_MEET,
      meeting_status: MeetingCreationStatus.READY,
      meeting_host_url: 'https://meet.example.test/host/one-to-one',
      meeting_passcode: '123456',
      meeting_error: null,
      meeting_attempts: 1,
      cancellation_reason: null,
      lesson: { id: 'lesson-1', is_group: false },
      bookings: [],
      ...overrides,
    }) as ScheduledLessonSession;

  it('toSafeSession (the public/guest shape used by listPublic) never includes any meeting field', () => {
    const toSafeSession =
      accessPrivate<(s: ScheduledLessonSession) => Record<string, unknown>>('toSafeSession');
    const safe = toSafeSession.call(service, fullSession());
    for (const key of Object.keys(safe)) {
      expect(key.startsWith('meeting')).toBe(false);
    }
  });

  it('toStudentBooking never includes meeting_host_url or meeting_passcode, held or confirmed', () => {
    const toStudentBooking =
      accessPrivate<
        (booking: LessonSessionBooking, session: ScheduledLessonSession) => Record<string, unknown>
      >('toStudentBooking');
    const session = fullSession();
    for (const status of [LessonSessionBookingStatus.HELD, LessonSessionBookingStatus.CONFIRMED]) {
      const result = toStudentBooking.call(
        service,
        { id: 'booking-1', status } as LessonSessionBooking,
        session,
      );
      const resultSession = result['session'] as Record<string, unknown>;
      expect(resultSession).not.toHaveProperty('meeting_host_url');
      expect(resultSession).not.toHaveProperty('meeting_passcode');
    }
  });

  it('toStudentBooking exposes meeting_url only once the booking is confirmed — held and payment_review both see null', () => {
    const toStudentBooking =
      accessPrivate<
        (booking: LessonSessionBooking, session: ScheduledLessonSession) => Record<string, unknown>
      >('toStudentBooking');
    const session = fullSession();
    for (const status of [
      LessonSessionBookingStatus.HELD,
      LessonSessionBookingStatus.PAYMENT_REVIEW,
    ]) {
      const result = toStudentBooking.call(
        service,
        { id: 'booking-1', status } as LessonSessionBooking,
        session,
      );
      expect((result['session'] as Record<string, unknown>)['meeting_url']).toBeNull();
    }
    const confirmed = toStudentBooking.call(
      service,
      { id: 'booking-1', status: LessonSessionBookingStatus.CONFIRMED } as LessonSessionBooking,
      session,
    );
    expect((confirmed['session'] as Record<string, unknown>)['meeting_url']).toBe(
      'https://meet.example.test/one-to-one',
    );
  });

  it('toPrivilegedSession (owner teacher / admin only) exposes the full meeting record including host_url and passcode', () => {
    const toPrivilegedSession =
      accessPrivate<(s: ScheduledLessonSession) => Record<string, unknown>>('toPrivilegedSession');
    const result = toPrivilegedSession.call(service, fullSession());
    expect(result['meeting_url']).toBe('https://meet.example.test/one-to-one');
    expect(result['meeting_host_url']).toBe('https://meet.example.test/host/one-to-one');
    expect(result['meeting_passcode']).toBe('123456');
    expect(result['meeting_provider']).toBe(MeetingProvider.GOOGLE_MEET);
  });
});

describe('LessonSessionsService.listForStudent (T088)', () => {
  function build() {
    const find = jest.fn().mockResolvedValue([]);
    const deps = noopMeetingDeps();
    const service = new LessonSessionsService(
      { getRepository: jest.fn().mockReturnValue({ find }) } as unknown as DataSource,
      { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
      { send: jest.fn() } as unknown as MailService,
      deps.registry,
      deps.accounts,
      deps.queue,
    );
    return { service, find };
  }

  it('without a lesson filter the query is exactly the caller bookings, same relations and order', async () => {
    const { service, find } = build();

    await service.listForStudent('student-1');

    expect(find).toHaveBeenCalledWith({
      where: { student_id: 'student-1' },
      relations: ['session', 'session.lesson', 'session.teacher', 'order', 'payment'],
      order: { created_at: 'DESC' },
    });
  });

  it('with a lesson filter it only narrows the caller own bookings to that lesson', async () => {
    const { service, find } = build();

    await service.listForStudent('student-1', 'lesson-9');

    expect(find).toHaveBeenCalledWith({
      where: { student_id: 'student-1', session: { lesson_id: 'lesson-9' } },
      relations: ['session', 'session.lesson', 'session.teacher', 'order', 'payment'],
      order: { created_at: 'DESC' },
    });
  });
});
