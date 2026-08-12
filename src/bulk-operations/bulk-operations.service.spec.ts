import { BulkOperationsService } from './bulk-operations.service';
import { BadRequestException } from '@nestjs/common';
import { BulkUserAction } from './dto';

describe('BulkOperationsService', () => {
  const originalRedisUrl = process.env['REDIS_URL'];
  const usersRepository = {
    find: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const bulkNotificationsQueue = { add: jest.fn() };
  const campaign = {
    id: 'campaign-1',
    idempotency_key: 'request-1',
    intended_count: 2500,
    created_count: 0,
    failed_count: 0,
    status: 'queued',
    created_at: new Date('2026-08-12T00:00:00Z'),
    queued_at: new Date('2026-08-12T00:00:00Z'),
    started_at: null,
    completed_at: null,
  };
  const notificationCampaigns = {
    findOne: jest.fn(),
    create: jest.fn((value) => ({ ...campaign, ...value })),
    save: jest.fn(async (value) => value),
    update: jest.fn(),
  };
  const activityLogs = { recordAuditEvent: jest.fn().mockResolvedValue(undefined) };
  const service = new BulkOperationsService(
    usersRepository as never,
    {} as never,
    notificationCampaigns as never,
    {} as never,
    {} as never,
    {} as never,
    activityLogs as never,
    bulkNotificationsQueue as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    process.env['REDIS_URL'] = 'redis://localhost:6379';
  });

  afterAll(() => {
    if (originalRedisUrl === undefined) delete process.env['REDIS_URL'];
    else process.env['REDIS_URL'] = originalRedisUrl;
  });

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
    notificationCampaigns.findOne.mockResolvedValue(null);

    const result = await service.sendBulkNotifications(
      { message: 'A scheduled update is available.', filter: {} },
      'admin-id',
      'request-1',
    );

    expect(bulkNotificationsQueue.add).toHaveBeenCalledWith(
      'deliver-bulk-notifications',
      expect.objectContaining({ adminId: 'admin-id', campaignId: 'campaign-1' }),
      expect.objectContaining({ jobId: 'notification-campaign-campaign-1' }),
    );
    expect(result).toMatchObject({
      campaign_id: 'campaign-1',
      total_queued: 2500,
      status: 'queued',
      job_id: 'job-123',
    });
  });

  it('returns an existing campaign for a repeated idempotency key', async () => {
    notificationCampaigns.findOne.mockResolvedValue(campaign);

    const result = await service.sendBulkNotifications(
      { message: 'Same request', filter: {} },
      'admin-id',
      'request-1',
    );

    expect(result.campaign_id).toBe('campaign-1');
    expect(bulkNotificationsQueue.add).not.toHaveBeenCalled();
  });

  it('rejects explicit audiences containing inactive, missing, or non-student users', async () => {
    const query = {
      leftJoin: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      getCount: jest.fn().mockResolvedValue(1),
    };
    query.leftJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.andWhere.mockReturnValue(query);
    usersRepository.createQueryBuilder.mockReturnValue(query);
    notificationCampaigns.findOne.mockResolvedValue(null);

    await expect(
      service.sendBulkNotifications(
        {
          message: 'Selected users',
          filter: { student_ids: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'] },
        },
        'admin-id',
        'request-invalid-audience',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(notificationCampaigns.save).not.toHaveBeenCalled();
  });
});
