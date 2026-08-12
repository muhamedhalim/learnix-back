import { NotificationDispatchRecoveryService } from './notification-dispatch-recovery.service';

describe('NotificationDispatchRecoveryService', () => {
  const originalRedisUrl = process.env['REDIS_URL'];
  const originalNotificationsFlag = process.env['ENABLE_NOTIFICATIONS'];

  afterAll(() => {
    if (originalRedisUrl === undefined) delete process.env['REDIS_URL'];
    else process.env['REDIS_URL'] = originalRedisUrl;
    if (originalNotificationsFlag === undefined) delete process.env['ENABLE_NOTIFICATIONS'];
    else process.env['ENABLE_NOTIFICATIONS'] = originalNotificationsFlag;
  });

  it('re-enqueues only rows returned by the missing-delivery query with fresh job ids', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    process.env['ENABLE_NOTIFICATIONS'] = 'true';
    const query = {
      select: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      addOrderBy: jest.fn(),
      limit: jest.fn(),
      getRawMany: jest.fn().mockResolvedValue([{ id: 'notification-1' }, { id: 'notification-2' }]),
    };
    for (const method of [
      'select',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'limit',
    ] as const) {
      query[method].mockReturnValue(query);
    }
    const notifications = { createQueryBuilder: jest.fn().mockReturnValue(query) };
    const pushJobs = { enqueueDelivery: jest.fn().mockResolvedValue(undefined) };
    const service = new NotificationDispatchRecoveryService(
      notifications as never,
      pushJobs as never,
    );

    await expect(service.recoverMissingPushDecisions()).resolves.toBe(2);
    expect(pushJobs.enqueueDelivery).toHaveBeenNthCalledWith(1, 'notification-1', {
      forceNewJob: true,
    });
    expect(pushJobs.enqueueDelivery).toHaveBeenNthCalledWith(2, 'notification-2', {
      forceNewJob: true,
    });
  });

  it('does nothing while outbound notifications are paused', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    process.env['ENABLE_NOTIFICATIONS'] = 'false';
    const notifications = { createQueryBuilder: jest.fn() };
    const pushJobs = { enqueueDelivery: jest.fn() };
    const service = new NotificationDispatchRecoveryService(
      notifications as never,
      pushJobs as never,
    );

    await expect(service.recoverMissingPushDecisions()).resolves.toBe(0);
    expect(notifications.createQueryBuilder).not.toHaveBeenCalled();
  });
});
