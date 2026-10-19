import { areQueuesEnabled, JOB_TYPES } from '../../queues/queues.constants';
import { PushNotificationJobsService } from './push-notification-jobs.service';

jest.mock('../../queues/queues.constants', () => ({
  ...jest.requireActual<typeof import('../../queues/queues.constants')>(
    '../../queues/queues.constants',
  ),
  areQueuesEnabled: jest.fn(),
}));

/** T069: push for many persisted notifications keeps the per-notification job id and inline fallback. */
describe('PushNotificationJobsService.enqueueDeliveryMany', () => {
  let queue: { add: jest.Mock; addBulk: jest.Mock };
  let dispatcher: { dispatch: jest.Mock };
  let service: PushNotificationJobsService;

  beforeEach(() => {
    queue = { add: jest.fn(), addBulk: jest.fn().mockResolvedValue([]) };
    dispatcher = { dispatch: jest.fn().mockResolvedValue({ status: 'sent' }) };
    service = new PushNotificationJobsService(queue as never, dispatcher as never, {} as never);
  });

  it('adds one bulk job per notification with the same deterministic ids as enqueueDelivery', async () => {
    (areQueuesEnabled as jest.Mock).mockReturnValue(true);

    await service.enqueueDeliveryMany(['n1', 'n2', 'n3']);
    await service.enqueueDelivery('n9');

    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    expect(queue.addBulk).toHaveBeenCalledWith([
      { name: JOB_TYPES.PUSH.DELIVER, data: { notificationId: 'n1' }, opts: { jobId: 'push.n1' } },
      { name: JOB_TYPES.PUSH.DELIVER, data: { notificationId: 'n2' }, opts: { jobId: 'push.n2' } },
      { name: JOB_TYPES.PUSH.DELIVER, data: { notificationId: 'n3' }, opts: { jobId: 'push.n3' } },
    ]);
    // The single-notification path uses the same id scheme.
    expect(queue.add).toHaveBeenCalledWith(
      JOB_TYPES.PUSH.DELIVER,
      { notificationId: 'n9' },
      { jobId: 'push.n9' },
    );
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('does nothing for an empty list', async () => {
    (areQueuesEnabled as jest.Mock).mockReturnValue(true);

    await service.enqueueDeliveryMany([]);

    expect(queue.addBulk).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('with queues disabled dispatches each notification inline and swallows provider errors', async () => {
    (areQueuesEnabled as jest.Mock).mockReturnValue(false);
    dispatcher.dispatch.mockImplementation(async (id: string) => {
      if (id === 'n2') throw new Error('provider down');
      return { status: 'sent' };
    });

    await expect(service.enqueueDeliveryMany(['n1', 'n2', 'n3'])).resolves.toBeUndefined();

    expect(queue.addBulk).not.toHaveBeenCalled();
    expect(dispatcher.dispatch.mock.calls.map(([id]) => id).sort()).toEqual(['n1', 'n2', 'n3']);
  });
});
