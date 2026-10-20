import {
  ADMIN_INBOX_ALWAYS_ELIGIBLE_EVENTS,
  AdminNotificationEvent,
} from '../constants/admin-notification-events';
import { AdminNotificationCategory } from '../entities/admin-notification-category.enum';
import { NotificationOrigin } from '../entities/notification-origin.enum';
import { NotificationsService } from './notifications.service';

function buildQueryBuilder(rows: unknown[] = []) {
  const qb: Record<string, jest.Mock> = {
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, rows.length]),
    getCount: jest.fn().mockResolvedValue(rows.length),
  };
  for (const method of ['where', 'andWhere', 'orderBy', 'skip', 'take']) {
    qb[method]!.mockReturnValue(qb);
  }
  return qb;
}

function buildService(qb: ReturnType<typeof buildQueryBuilder>) {
  const notificationsRepository = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    create: jest.fn((input: unknown) => input),
    save: jest.fn((entity: unknown) => Promise.resolve(entity)),
  };
  const service = new NotificationsService(
    notificationsRepository as never,
    {} as never, // users repository — unused by the methods under test
    {} as never, // guardiansService
    {} as never, // smsSenderService
    {} as never, // channelPolicy
    { enqueueDelivery: jest.fn().mockResolvedValue(undefined) } as never, // pushJobs
    {} as never, // notificationDeliveries
  );
  return { service, notificationsRepository };
}

describe('NotificationsService.findAllForUser', () => {
  it("restricts an admin's own inbox to business notifications, excluding monitoring alerts", async () => {
    const qb = buildQueryBuilder();
    const { service } = buildService(qb);

    await service.findAllForUser('admin-1', {}, 'admin');

    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('notification.source_event IN'),
      expect.objectContaining({
        inboxEvents: [...ADMIN_INBOX_ALWAYS_ELIGIBLE_EVENTS],
        inboxOperationalEvent: AdminNotificationEvent.OPERATIONAL_ALERT,
        inboxOperationalCategories: [
          AdminNotificationCategory.FINANCIAL,
          AdminNotificationCategory.SECURITY,
        ],
        inboxOperationalOrigin: NotificationOrigin.OPERATIONAL,
      }),
    );
    // `operational_alert` is only admitted through its category-gated clause.
    const params = qb.andWhere.mock.calls.find(([sql]) =>
      String(sql).includes('source_event IN'),
    )?.[1] as { inboxEvents: string[] };
    expect(params.inboxEvents).not.toContain(AdminNotificationEvent.OPERATIONAL_ALERT);
  });

  it('does not restrict a student, teacher, or call-center inbox', async () => {
    for (const role of ['student', 'teacher', 'call_center', undefined]) {
      const qb = buildQueryBuilder();
      const { service } = buildService(qb);

      await service.findAllForUser('user-1', {}, role);

      const restrictingCall = qb.andWhere.mock.calls.find(([sql]) =>
        String(sql).includes('source_event IN'),
      );
      expect(restrictingCall).toBeUndefined();
    }
  });

  it('applies an optional priority filter for any role', async () => {
    const qb = buildQueryBuilder();
    const { service } = buildService(qb);

    await service.findAllForUser('admin-1', { priority: 'critical' } as never, 'admin');

    expect(qb.andWhere).toHaveBeenCalledWith('notification.priority = :priority', {
      priority: 'critical',
    });
  });
});

describe('NotificationsService.getUnreadCount', () => {
  it("restricts an admin's unread badge to the same allow-list as their inbox", async () => {
    const qb = buildQueryBuilder([{ id: 'n1' }]);
    const { service } = buildService(qb);

    await service.getUnreadCount('admin-1', 'admin');

    expect(qb.andWhere).toHaveBeenCalledWith('notification.is_read = false');
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('notification.source_event IN'),
      expect.objectContaining({
        inboxEvents: [...ADMIN_INBOX_ALWAYS_ELIGIBLE_EVENTS],
        inboxOperationalCategories: [
          AdminNotificationCategory.FINANCIAL,
          AdminNotificationCategory.SECURITY,
        ],
      }),
    );
  });

  it('does not restrict a non-admin unread count', async () => {
    const qb = buildQueryBuilder([{ id: 'n1' }]);
    const { service } = buildService(qb);

    await service.getUnreadCount('student-1', 'student');

    const restrictingCall = qb.andWhere.mock.calls.find(([sql]) =>
      String(sql).includes('source_event IN'),
    );
    expect(restrictingCall).toBeUndefined();
  });
});

describe('NotificationsService.create', () => {
  it('persists priority, category, and link when supplied', async () => {
    const qb = buildQueryBuilder();
    const { service, notificationsRepository } = buildService(qb);

    await service.create(
      {
        user_id: 'admin-1',
        type: 'custom' as never,
        title: 'New instructor registration request',
        message: 'Jane Doe requested to register as an instructor.',
        priority: 'high' as never,
        category: 'instructor_approval' as never,
        link: '/admin/teachers?status=pending',
        send_sms: false,
      },
      false,
    );

    expect(notificationsRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: 'high',
        category: 'instructor_approval',
        link: '/admin/teachers?status=pending',
      }),
    );
  });

  it('defaults priority, category, and link to null when omitted', async () => {
    const qb = buildQueryBuilder();
    const { service, notificationsRepository } = buildService(qb);

    await service.create(
      {
        user_id: 'student-1',
        type: 'homework' as never,
        title: 'Homework graded',
        message: 'Your homework was graded.',
      },
      false,
    );

    expect(notificationsRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ priority: null, category: null, link: null }),
    );
  });
});

describe('NotificationsService.createMany (T069)', () => {
  interface Harness {
    service: NotificationsService;
    calls: string[];
    valuesArgs: Array<Array<Record<string, unknown>>>;
    repo: {
      createQueryBuilder: jest.Mock;
      create: jest.Mock;
      save: jest.Mock;
      manager: { transaction: jest.Mock; connection: { createQueryRunner: jest.Mock } };
    };
    pushJobs: { enqueueDelivery: jest.Mock; enqueueDeliveryMany: jest.Mock };
  }

  function harness(
    options: {
      failInsertAtCall?: number;
      failSaveForUserIds?: string[];
      pushManyFails?: boolean;
    } = {},
  ): Harness {
    const calls: string[] = [];
    const valuesArgs: Harness['valuesArgs'] = [];
    let insertCall = 0;
    const insertQb: Record<string, jest.Mock> = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn((rows: Array<Record<string, unknown>>) => {
        valuesArgs.push(rows);
        return insertQb;
      }),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn(async () => {
        insertCall += 1;
        calls.push(`insert:${String(insertCall)}`);
        if (options.failInsertAtCall === insertCall) throw new Error('multi-row insert failed');
        const rows = valuesArgs[valuesArgs.length - 1] ?? [];
        return { identifiers: rows.map((row) => ({ id: `n-${String(row['user_id'])}` })) };
      }),
    };
    const repo = {
      createQueryBuilder: jest.fn().mockReturnValue(insertQb),
      create: jest.fn((value: unknown) => value),
      save: jest.fn(async (entity: { user_id: string }) => {
        if (options.failSaveForUserIds?.includes(entity.user_id))
          throw new Error('row insert failed');
        calls.push(`save:${entity.user_id}`);
        return { ...entity, id: `n-${entity.user_id}` };
      }),
      manager: { transaction: jest.fn(), connection: { createQueryRunner: jest.fn() } },
    };
    const pushJobs = {
      enqueueDelivery: jest.fn(async (id: string) => {
        calls.push(`push:${id}`);
      }),
      enqueueDeliveryMany: jest.fn(async (ids: string[]) => {
        calls.push(`pushMany:${String(ids.length)}:${ids[0] ?? ''}`);
        if (options.pushManyFails) throw new Error('redis down');
      }),
    };
    const service = new NotificationsService(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      pushJobs as never,
      {} as never,
    );
    return { service, calls, valuesArgs, repo, pushJobs };
  }

  const rowsFor = (count: number, extra: Record<string, unknown> = {}) =>
    Array.from({ length: count }, (_unused, index) => ({
      user_id: `u${String(index)}`,
      type: 'exam_assigned' as never,
      title: 'Title',
      message: 'Message',
      data: { exam_id: 'e1' },
      send_sms: false,
      ...extra,
    }));

  it('writes exactly the columns create() writes (defaults parity)', async () => {
    const { service, repo, valuesArgs } = harness();
    const input = {
      user_id: 'u1',
      type: 'homework' as never,
      title: 'T',
      message: 'M',
      data: { a: 1 },
      send_sms: false,
      link: '/x',
    };

    await service.create(input, false);
    await service.createMany([input]);

    const created = repo.create.mock.calls[0]?.[0] as Record<string, unknown>;
    const inserted = valuesArgs[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(inserted).sort()).toEqual(Object.keys(created).sort());
    const withoutClock = (row: Record<string, unknown>) => ({ ...row, sent_at: undefined });
    expect(withoutClock(inserted)).toEqual(withoutClock(created));
    expect(inserted).toMatchObject({
      origin: 'system',
      status: 'sent',
      sms_sent: false,
      attempts: 0,
      dedupe_key: null,
      priority: null,
      category: null,
      delivered_at: null,
    });
    expect(inserted['sent_at']).toBeInstanceOf(Date);
  });

  it('does nothing for an empty list', async () => {
    const { service, repo, pushJobs } = harness();

    await expect(service.createMany([])).resolves.toEqual([]);
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    expect(pushJobs.enqueueDeliveryMany).not.toHaveBeenCalled();
  });

  it('inserts in chunks of 500 on the repository (autocommit) and pushes each chunk after its insert', async () => {
    const { service, calls, valuesArgs, repo } = harness();

    const outcomes = await service.createMany(rowsFor(1203));

    expect(valuesArgs.map((chunk) => chunk.length)).toEqual([500, 500, 203]);
    expect(outcomes).toHaveLength(1203);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(outcomes[0]).toEqual({ ok: true, id: 'n-u0' });
    expect(outcomes[1202]).toEqual({ ok: true, id: 'n-u1202' });
    expect(calls).toEqual([
      'insert:1',
      'pushMany:500:n-u0',
      'insert:2',
      'pushMany:500:n-u500',
      'insert:3',
      'pushMany:203:n-u1000',
    ]);
    expect(repo.manager.transaction).not.toHaveBeenCalled();
    expect(repo.manager.connection.createQueryRunner).not.toHaveBeenCalled();
  });

  it('skips push when asked to and never fails the caller when the push enqueue fails', async () => {
    const quiet = harness();
    await quiet.service.createMany(rowsFor(3), { push: false });
    expect(quiet.pushJobs.enqueueDeliveryMany).not.toHaveBeenCalled();

    const broken = harness({ pushManyFails: true });
    const outcomes = await broken.service.createMany(rowsFor(3));
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
  });

  it('refuses a row that asks for SMS instead of silently skipping the guardian fan-out', async () => {
    const { service, repo } = harness();

    await expect(service.createMany(rowsFor(2, { send_sms: true }))).rejects.toThrow(
      /never sends SMS/,
    );
    await expect(service.createMany(rowsFor(2, { send_sms: undefined }))).rejects.toThrow(
      /never sends SMS/,
    );
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('partial failure: chunk 2 falls back per row, chunk 1 stays committed and pushed, chunk 3 proceeds, no transaction', async () => {
    const { service, calls, repo, pushJobs } = harness({
      failInsertAtCall: 2,
      failSaveForUserIds: ['u700'],
    });

    const outcomes = await service.createMany(rowsFor(1100));

    // Order: chunk 1 insert + push happen before chunk 2 is even attempted.
    expect(calls.slice(0, 3)).toEqual(['insert:1', 'pushMany:500:n-u0', 'insert:2']);
    // Nothing is pushed for chunk 2 between its failed multi-row insert and the per-row saves.
    expect(calls[3]).toBe('save:u500');
    // Every fallback push comes right after its own row's save; the failing row has neither.
    for (let index = 500; index < 1000; index += 1) {
      const user = `u${String(index)}`;
      const savedAt = calls.indexOf(`save:${user}`);
      if (index === 700) {
        expect(savedAt).toBe(-1);
        expect(calls).not.toContain(`push:n-${user}`);
      } else {
        expect(calls[savedAt + 1]).toBe(`push:n-${user}`);
      }
    }
    // Chunk 3 then proceeds normally.
    expect(calls.slice(-2)).toEqual(['insert:3', 'pushMany:100:n-u1000']);
    expect(pushJobs.enqueueDeliveryMany).toHaveBeenCalledTimes(2); // chunks 1 and 3 only

    expect(outcomes).toHaveLength(1100);
    expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(1);
    expect(outcomes[700]).toMatchObject({ ok: false });
    expect(outcomes[699]).toEqual({ ok: true, id: 'n-u699' });
    expect(outcomes[1099]).toEqual({ ok: true, id: 'n-u1099' });
    expect(repo.manager.transaction).not.toHaveBeenCalled();
    expect(repo.manager.connection.createQueryRunner).not.toHaveBeenCalled();
  });

  it('never re-inserts a chunk whose multi-row insert succeeded', async () => {
    const { service, repo } = harness({ pushManyFails: true });

    await service.createMany(rowsFor(10));

    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
  });
});
