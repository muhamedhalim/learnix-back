import { Logger } from '@nestjs/common';

import { performanceMetrics } from '../../observability/performance-metrics.registry';
import { SCHEDULED_JOB_REPEATED_FAILURE_EVENT } from '../../observability/scheduled-job-monitor.service';
import type { OperationalAlertService } from '../operational-alert.service';
import { FinancialOperationsAlertListener } from './financial-operations-alert.listener';

function buildListener(): {
  listener: FinancialOperationsAlertListener;
  dispatch: jest.Mock;
} {
  const dispatch = jest.fn().mockResolvedValue(undefined);
  const listener = new FinancialOperationsAlertListener({
    dispatch,
  } as unknown as OperationalAlertService);
  return { listener, dispatch };
}

/** Payment-domain failure count from the rolling window. */
function paymentFailures(): number {
  return performanceMetrics.snapshot().window.failures.payment;
}

describe('FinancialOperationsAlertListener', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockRestore());

  describe('every critical financial event reaches a human', () => {
    it('alerts on a dead-lettered payment webhook', async () => {
      const { listener, dispatch } = buildListener();

      await listener.onWebhookDeadLetter({
        webhook_event_id: 'evt-1',
        payment_id: 'pay-1',
        error: 'Maximum webhook attempts exhausted',
      });

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'payment.webhook_dead_letter:evt-1',
          severity: 'critical',
          context: expect.objectContaining({
            paymentId: 'pay-1',
            webhookEventId: 'evt-1',
            failureCategory: 'webhook_dead_letter',
          }),
        }),
      );
    });

    it('alerts on a quarantined payment', async () => {
      const { listener, dispatch } = buildListener();
      await listener.onPaymentQuarantined({ payment_id: 'pay-2', reason: 'mismatch' });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'payment.reconciliation_alert:pay-2' }),
      );
    });

    it('alerts on a stuck payment reconciliation', async () => {
      const { listener, dispatch } = buildListener();
      await listener.onPaymentReconciliationStuck({ payment_id: 'pay-3', attempts: 4 });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'payment.reconciliation_stuck:pay-3',
          context: expect.objectContaining({ attempts: 4 }),
        }),
      );
    });

    it('alerts when a captured payment needs fulfillment compensation', async () => {
      const { listener, dispatch } = buildListener();
      await listener.onFulfillmentCompensationRequired({
        payment_id: 'pay-4',
        order_id: 'ord-4',
        reason: 'entitlement write failed',
      });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'payment.fulfillment_compensation_required:pay-4',
          context: expect.objectContaining({ orderId: 'ord-4' }),
        }),
      );
    });

    it('alerts on a dead-lettered outbox event', async () => {
      const { listener, dispatch } = buildListener();
      await listener.onOutboxDeadLetter({
        outbox_event_id: 'ob-1',
        event_name: 'payment.succeeded',
      });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'payment.outbox_dead_letter:ob-1',
          context: expect.objectContaining({ originalEvent: 'payment.succeeded' }),
        }),
      );
    });

    it('alerts on a quarantined refund', async () => {
      const { listener, dispatch } = buildListener();
      await listener.onRefundQuarantined({ refund_id: 'ref-1', reason: 'mismatch' });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'refund.reconciliation_alert:ref-1' }),
      );
    });

    it('alerts when a refund needs manual review', async () => {
      const { listener, dispatch } = buildListener();
      await listener.onRefundReviewRequired({ refund_id: 'ref-2', payment_id: 'pay-9' });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'refund.reconciliation_required:ref-2',
          context: expect.objectContaining({ paymentId: 'pay-9' }),
        }),
      );
    });

    it('alerts on a stuck refund reconciliation', async () => {
      const { listener, dispatch } = buildListener();
      await listener.onRefundReconciliationStuck({ refund_id: 'ref-3', attempts: 5 });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'refund.reconciliation_stuck:ref-3' }),
      );
    });

    it('alerts on repeated finance maintenance failure', async () => {
      const { listener, dispatch } = buildListener();
      await listener.onMaintenanceRepeatedFailure({
        task_name: 'publish_outbox',
        failures: 3,
        error: 'deadlock detected',
      });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'finance.maintenance.repeated_failure:publish_outbox',
          context: expect.objectContaining({ consecutiveFailures: 3 }),
        }),
      );
    });

    it('alerts on a repeatedly failing scheduled job', async () => {
      const { listener, dispatch } = buildListener();
      await listener.onScheduledJobRepeatedFailure({
        jobName: 'payments.gateway_reconciliation',
        consecutiveFailures: 3,
        errorCategory: 'ETIMEDOUT',
      });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          key: `${SCHEDULED_JOB_REPEATED_FAILURE_EVENT}:payments.gateway_reconciliation`,
          severity: 'critical',
        }),
      );
    });
  });

  describe('payment failure metric', () => {
    it('increments the payment failure counter exactly once per incident', async () => {
      const { listener } = buildListener();
      const before = paymentFailures();

      await listener.onWebhookDeadLetter({ webhook_event_id: 'evt-count', payment_id: 'pay-x' });

      expect(paymentFailures()).toBe(before + 1);
    });

    it('does not count a scheduled-job failure as a payment failure', async () => {
      const { listener } = buildListener();
      const before = paymentFailures();

      await listener.onScheduledJobRepeatedFailure({ jobName: 'some.job' });

      expect(paymentFailures()).toBe(before);
    });
  });

  describe('resilience', () => {
    it('never throws when alert dispatch fails, so the outbox does not redeliver', async () => {
      const dispatch = jest.fn().mockRejectedValue(new Error('alerting down'));
      const listener = new FinancialOperationsAlertListener({
        dispatch,
      } as unknown as OperationalAlertService);

      await expect(
        listener.onWebhookDeadLetter({ webhook_event_id: 'evt-2' }),
      ).resolves.toBeUndefined();

      expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        'critical_financial_incident_alert_failed',
      );
    });

    it('tolerates a malformed or empty event payload', async () => {
      const { listener, dispatch } = buildListener();

      await expect(listener.onWebhookDeadLetter(undefined)).resolves.toBeUndefined();
      await expect(listener.onPaymentQuarantined('not-an-object')).resolves.toBeUndefined();

      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        key: 'payment.webhook_dead_letter:unknown',
      });
    });

    it('truncates a very long provider error rather than flooding the alert', async () => {
      const { listener, dispatch } = buildListener();

      await listener.onWebhookDeadLetter({
        webhook_event_id: 'evt-3',
        error: 'x'.repeat(5_000),
      });

      const error = String(
        (dispatch.mock.calls[0]?.[0] as { context: Record<string, unknown> }).context['error'],
      );
      expect(error.length).toBeLessThanOrEqual(301);
      expect(error.endsWith('…')).toBe(true);
    });
  });

  describe('payload safety', () => {
    it('logs and alerts identifiers only, never amounts or provider payloads', async () => {
      const { listener, dispatch } = buildListener();

      await listener.onPaymentQuarantined({
        payment_id: 'pay-5',
        reason: 'mismatch',
        // Fields a future emitter might add; must not be forwarded.
        amount_minor: 129_900,
        card_number: '4111111111111111',
      });

      const serialised = JSON.stringify(dispatch.mock.calls[0]?.[0]);
      expect(serialised).toContain('pay-5');
      expect(serialised).not.toContain('129900');
      expect(serialised).not.toContain('4111111111111111');
    });
  });
});
