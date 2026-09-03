import { AdminNotificationEvent } from '../constants/admin-notification-events';
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
  it("restricts an admin's own inbox to the cataloged admin-notification allow-list", async () => {
    const qb = buildQueryBuilder();
    const { service } = buildService(qb);

    await service.findAllForUser('admin-1', {}, 'admin');

    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('notification.source_event IN'),
      expect.objectContaining({
        adminEvents: Object.values(AdminNotificationEvent),
        operationalOrigin: NotificationOrigin.OPERATIONAL,
      }),
    );
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
        adminEvents: Object.values(AdminNotificationEvent),
        operationalOrigin: NotificationOrigin.OPERATIONAL,
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
