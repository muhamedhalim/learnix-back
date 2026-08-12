import { BulkNotificationProcessor } from './bulk-notification.processor';

describe('BulkNotificationProcessor', () => {
  it('persists a large broadcast in bounded recipient batches', async () => {
    const recipientQuery = {
      leftJoin: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      select: jest.fn(),
      orderBy: jest.fn(),
      take: jest.fn(),
      getMany: jest.fn(),
    };
    for (const method of ['leftJoin', 'where', 'andWhere', 'select', 'orderBy', 'take'] as const) {
      recipientQuery[method].mockReturnValue(recipientQuery);
    }
    recipientQuery.getMany
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, index) => ({ id: `student-${String(index)}` })),
      )
      .mockResolvedValueOnce([{ id: 'student-500' }])
      .mockResolvedValueOnce([]);

    const insertQuery = {
      insert: jest.fn(),
      into: jest.fn(),
      values: jest.fn(),
      orIgnore: jest.fn(),
      returning: jest.fn(),
      execute: jest.fn(),
    };
    for (const method of ['insert', 'into', 'values', 'orIgnore', 'returning'] as const) {
      insertQuery[method].mockReturnValue(insertQuery);
    }
    insertQuery.execute
      .mockResolvedValueOnce({
        identifiers: Array.from({ length: 500 }, (_, index) => ({ id: `notification-${String(index)}` })),
      })
      .mockResolvedValueOnce({ identifiers: [{ id: 'notification-500' }] });

    const usersRepository = { createQueryBuilder: jest.fn().mockReturnValue(recipientQuery) };
    const notificationsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(insertQuery),
      count: jest.fn().mockResolvedValue(501),
    };
    const campaignsRepository = {
      update: jest.fn(),
      findOneByOrFail: jest.fn().mockResolvedValue({ id: 'campaign-1', intended_count: 501 }),
      findOneBy: jest.fn(),
    };
    const pushQueue = { addBulk: jest.fn().mockResolvedValue([]) };
    const processor = new BulkNotificationProcessor(
      usersRepository as never,
      notificationsRepository as never,
      campaignsRepository as never,
      pushQueue as never,
    );
    const job = {
      id: 'job-123',
      name: 'deliver-bulk-notifications',
      data: {
        dto: { message: 'Hello', filter: {} },
        adminId: 'admin-id',
        campaignId: 'campaign-1',
      },
      updateProgress: jest.fn(),
    };

    await processor.process(job as never);

    expect(insertQuery.execute).toHaveBeenCalledTimes(2);
    expect(insertQuery.values.mock.calls[0]?.[0]).toHaveLength(500);
    expect(insertQuery.values.mock.calls[1]?.[0]).toHaveLength(1);
    expect(job.updateProgress).toHaveBeenLastCalledWith(501);
    expect(pushQueue.addBulk).toHaveBeenCalledTimes(2);
    expect(campaignsRepository.update).toHaveBeenLastCalledWith(
      'campaign-1',
      expect.objectContaining({ status: 'completed', created_count: 501, failed_count: 0 }),
    );
  });
});
