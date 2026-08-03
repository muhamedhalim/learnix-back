import { BulkOperationsService } from './bulk-operations.service';
import { BulkUserAction } from './dto';

describe('BulkOperationsService', () => {
  const usersRepository = {
    find: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const bulkNotificationsQueue = { add: jest.fn() };
  const service = new BulkOperationsService(
    usersRepository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    bulkNotificationsQueue as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('updates eligible users in one database operation instead of a per-user save loop', async () => {
    usersRepository.find.mockResolvedValue([
      { id: 'student-a', is_active: true },
      { id: 'student-b', is_active: false },
    ]);
    usersRepository.update.mockResolvedValue({ affected: 1 });

    const result = await service.performBulkUserAction(
      { action: BulkUserAction.SUSPEND, user_ids: ['student-a', 'student-b'] },
      'admin-id',
    );

    expect(usersRepository.update).toHaveBeenCalledTimes(1);
    expect(usersRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.anything() }),
      { is_active: false },
    );
    expect(result).toMatchObject({ success_count: 1, skipped_count: 1, failed_count: 0 });
  });

  it('queues bulk notifications without loading or notifying every recipient in the request', async () => {
    const query = {
      leftJoin: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      getCount: jest.fn(),
    };
    query.leftJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.andWhere.mockReturnValue(query);
    query.getCount.mockResolvedValue(2500);
    usersRepository.createQueryBuilder.mockReturnValue(query);
    bulkNotificationsQueue.add.mockResolvedValue({ id: 'job-123' });

    const result = await service.sendBulkNotifications(
      { message: 'A scheduled update is available.', filter: { grade_level: '10' } },
      'admin-id',
    );

    expect(bulkNotificationsQueue.add).toHaveBeenCalledWith(
      'deliver-bulk-notifications',
      expect.objectContaining({ adminId: 'admin-id' }),
    );
    expect(result).toMatchObject({ total_queued: 2500, status: 'processing', job_id: 'job-123' });
  });
});
