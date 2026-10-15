import { registerCronLockDataSource } from '../../common/utils/cron-lock.util';
import { PaymentOperationsService } from './payment-operations.service';

describe('PaymentOperationsService.reconcileGatewayAttempts cluster lock', () => {
  afterEach(() => registerCronLockDataSource(null));

  it('does not run when another replica holds the lock', async () => {
    const query = jest.fn().mockResolvedValue([{ ok: false }]);
    const release = jest.fn().mockResolvedValue(undefined);
    registerCronLockDataSource({
      createQueryRunner: () => ({ connect: jest.fn(), query, release }),
    } as never);
    const run = jest.fn();
    const self = { jobMonitor: { run }, logger: { log: jest.fn() } };

    await PaymentOperationsService.prototype.reconcileGatewayAttempts.call(self);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('pg_try_advisory_lock'), [
      'learnix-cron:payments.gateway_reconciliation',
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });
});
