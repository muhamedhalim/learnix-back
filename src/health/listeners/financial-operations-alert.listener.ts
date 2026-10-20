import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { getCurrentRequestId } from '../../observability/performance-context';
import { performanceMetrics } from '../../observability/performance-metrics.registry';
import { SCHEDULED_JOB_REPEATED_FAILURE_EVENT } from '../../observability/scheduled-job-monitor.service';
import { OperationalAlertService, type AlertContext } from '../operational-alert.service';

/**
 * Turns terminal financial failures into operational alerts.
 *
 * The payment subsystem already records these incidents durably and correctly:
 * `gateway_webhook_events` dead-letters after its attempt cap, reconciliation
 * quarantines a mismatched payment or refund, and the outbox publishes a
 * dedicated domain event for each. Every one of those events was emitted with
 * NO subscriber — the outbox marked them `published` into the void, so money
 * could sit stuck in `dead_letter` or `quarantined` indefinitely with nobody
 * informed.
 *
 * This listener is the missing consumer, and nothing more. It does not touch
 * the payment state machine, does not write payment state, and never throws:
 *
 *   - Not throwing is load-bearing. `PaymentOperationsService.publishOutbox`
 *     marks an event `published` only if `emitAsync` resolves; a throwing
 *     listener would send the event back through the retry path and deliver a
 *     duplicate notification on every pass.
 *   - It lives in `HealthModule` rather than `PaymentsModule` because
 *     `HealthModule` already imports `PaymentsModule` (for the gateway health
 *     probe). Registering it the other way round would close an import cycle,
 *     and this listener needs no payment service at all — only the event
 *     payload the outbox hands it.
 *
 * Only safe identifiers travel into the alert: entity ids, provider name,
 * failure category, attempt counts, the correlation id when one is in scope.
 * Never an amount, a customer, a provider payload, or a credential.
 */
@Injectable()
export class FinancialOperationsAlertListener {
  private readonly logger = new Logger(FinancialOperationsAlertListener.name);

  public constructor(private readonly alerts: OperationalAlertService) {}

  @OnEvent('payment.webhook_dead_letter')
  public async onWebhookDeadLetter(payload: unknown): Promise<void> {
    const data = asRecord(payload);
    await this.raise({
      event: 'payment.webhook_dead_letter',
      identity: str(data['webhook_event_id']) ?? str(data['payment_id']) ?? 'unknown',
      title: 'Payment webhook dead-lettered',
      message:
        'A provider webhook exhausted every processing attempt and is now in dead-letter state. ' +
        'The payment will not progress until an operator reviews and replays it.',
      context: {
        webhookEventId: str(data['webhook_event_id']) ?? null,
        paymentId: str(data['payment_id']) ?? null,
        failureCategory: 'webhook_dead_letter',
        error: truncate(str(data['error'])),
      },
    });
  }

  @OnEvent('payment.reconciliation_alert')
  public async onPaymentQuarantined(payload: unknown): Promise<void> {
    const data = asRecord(payload);
    await this.raise({
      event: 'payment.reconciliation_alert',
      identity: str(data['payment_id']) ?? 'unknown',
      title: 'Payment quarantined during reconciliation',
      message:
        'The provider transaction did not match the internal payment record, so the payment was ' +
        'quarantined and excluded from automatic reconciliation. Manual financial review is required.',
      context: {
        paymentId: str(data['payment_id']) ?? null,
        failureCategory: 'payment_quarantined',
        reason: truncate(str(data['reason'])),
      },
    });
  }

  @OnEvent('payment.reconciliation_stuck')
  public async onPaymentReconciliationStuck(payload: unknown): Promise<void> {
    const data = asRecord(payload);
    await this.raise({
      event: 'payment.reconciliation_stuck',
      identity: str(data['payment_id']) ?? 'unknown',
      title: 'Payment reconciliation is stuck',
      message:
        'Provider reconciliation for this payment has failed repeatedly and is backing off. ' +
        'The payment remains in a non-terminal state.',
      context: {
        paymentId: str(data['payment_id']) ?? null,
        failureCategory: 'payment_reconciliation_stuck',
        attempts: num(data['attempts']),
        nextRetryAt: str(data['next_retry_at']) ?? null,
        error: truncate(str(data['error'])),
      },
    });
  }

  @OnEvent('payment.fulfillment_compensation_required')
  public async onFulfillmentCompensationRequired(payload: unknown): Promise<void> {
    const data = asRecord(payload);
    await this.raise({
      event: 'payment.fulfillment_compensation_required',
      identity: str(data['payment_id']) ?? 'unknown',
      title: 'Verified capture requires fulfillment compensation',
      message:
        'A payment was verifiably captured by the provider but fulfillment could not be completed. ' +
        'The customer has been charged; entitlement review is required.',
      context: {
        paymentId: str(data['payment_id']) ?? null,
        orderId: str(data['order_id']) ?? null,
        providerTransactionId: str(data['provider_transaction_id']) ?? null,
        failureCategory: 'fulfillment_compensation_required',
        reason: truncate(str(data['reason'])),
      },
    });
  }

  @OnEvent('payment.outbox_dead_letter')
  public async onOutboxDeadLetter(payload: unknown): Promise<void> {
    const data = asRecord(payload);
    await this.raise({
      event: 'payment.outbox_dead_letter',
      identity: str(data['outbox_event_id']) ?? 'unknown',
      title: 'Financial outbox event dead-lettered',
      message:
        'A financial domain event could not be published after every retry. Downstream effects of ' +
        'that event (notifications, entitlements, follow-up processing) have not happened.',
      context: {
        outboxEventId: str(data['outbox_event_id']) ?? null,
        originalEvent: str(data['event_name']) ?? null,
        failureCategory: 'outbox_dead_letter',
        error: truncate(str(data['error'])),
      },
    });
  }

  @OnEvent('refund.reconciliation_alert')
  public async onRefundQuarantined(payload: unknown): Promise<void> {
    const data = asRecord(payload);
    await this.raise({
      event: 'refund.reconciliation_alert',
      identity: str(data['refund_id']) ?? 'unknown',
      title: 'Refund quarantined during reconciliation',
      message:
        'The provider transaction did not match the internal refund record, so the refund was ' +
        'quarantined. Manual financial review is required.',
      context: {
        refundId: str(data['refund_id']) ?? null,
        failureCategory: 'refund_quarantined',
        reason: truncate(str(data['reason'])),
      },
    });
  }

  @OnEvent('refund.reconciliation_required')
  public async onRefundReviewRequired(payload: unknown): Promise<void> {
    const data = asRecord(payload);
    await this.raise({
      event: 'refund.reconciliation_required',
      identity: str(data['refund_id']) ?? 'unknown',
      title: 'Refund requires manual reconciliation review',
      message:
        'The provider returned no matching refund fact for a refund that is still processing. ' +
        'Automatic reconciliation has stopped pending review.',
      context: {
        refundId: str(data['refund_id']) ?? null,
        paymentId: str(data['payment_id']) ?? null,
        failureCategory: 'refund_reconciliation_required',
        reason: truncate(str(data['reason'])),
      },
    });
  }

  @OnEvent('refund.reconciliation_stuck')
  public async onRefundReconciliationStuck(payload: unknown): Promise<void> {
    const data = asRecord(payload);
    await this.raise({
      event: 'refund.reconciliation_stuck',
      identity: str(data['refund_id']) ?? 'unknown',
      title: 'Refund reconciliation is stuck',
      message:
        'Provider reconciliation for this refund has failed repeatedly and is backing off. ' +
        'The customer may be waiting on money that has not moved.',
      context: {
        refundId: str(data['refund_id']) ?? null,
        paymentId: str(data['payment_id']) ?? null,
        failureCategory: 'refund_reconciliation_stuck',
        attempts: num(data['attempts']),
        nextRetryAt: str(data['next_retry_at']) ?? null,
        error: truncate(str(data['error'])),
      },
    });
  }

  @OnEvent('finance.maintenance.repeated_failure')
  public async onMaintenanceRepeatedFailure(payload: unknown): Promise<void> {
    const data = asRecord(payload);
    await this.raise({
      event: 'finance.maintenance.repeated_failure',
      identity: str(data['task_name']) ?? 'unknown',
      title: 'Financial maintenance task is failing repeatedly',
      message:
        'A scheduled financial maintenance task has failed on three consecutive runs. Order ' +
        'expiry, teacher earnings release, or outbox publishing may have stopped.',
      context: {
        taskName: str(data['task_name']) ?? null,
        failureCategory: 'finance_maintenance_repeated_failure',
        consecutiveFailures: num(data['failures']),
        error: truncate(str(data['error'])),
      },
    });
  }

  /**
   * Repeated failure of a monitored `@Cron` job (see
   * `ScheduledJobMonitorService`). Emitted rather than called directly so
   * `ObservabilityModule` need not depend on `HealthModule`.
   *
   * Not counted as a payment failure: the job may or may not be financial, and
   * the underlying error was already reported to Sentry by the monitor.
   */
  @OnEvent(SCHEDULED_JOB_REPEATED_FAILURE_EVENT)
  public async onScheduledJobRepeatedFailure(payload: unknown): Promise<void> {
    const data = asRecord(payload);
    const jobName = str(data['jobName']) ?? 'unknown';
    try {
      await this.alerts.dispatch({
        key: `scheduled_job.repeated_failure:${jobName}`,
        audience: 'technical',
        severity: 'critical',
        title: `Scheduled job "${jobName}" is failing repeatedly`,
        message:
          `The scheduled job "${jobName}" has failed on ${String(num(data['consecutiveFailures']) ?? 0)} ` +
          'consecutive runs. Work this job is responsible for is not being processed.',
        context: {
          jobName,
          failureCategory: 'scheduled_job_repeated_failure',
          consecutiveFailures: num(data['consecutiveFailures']),
          errorCategory: str(data['errorCategory']) ?? null,
          lastFailedAt: str(data['lastFailedAt']) ?? null,
          error: truncate(str(data['error'])),
        },
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'scheduled_job_alert_failed',
          jobName,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * Single choke point: counts the incident once and dispatches once.
   *
   * `recordFailure('payment')` is called HERE rather than at each emission
   * site so one incident increments the metric exactly once, no matter how
   * many code paths can produce it — which is what makes the
   * `repeated-payment-failures` alert rule meaningful rather than noisy.
   */
  private async raise(input: {
    event: string;
    identity: string;
    title: string;
    message: string;
    context: AlertContext;
  }): Promise<void> {
    try {
      performanceMetrics.recordFailure('payment');
      const requestId = getCurrentRequestId() ?? null;
      this.logger.error(
        JSON.stringify({
          event: 'critical_financial_incident',
          incident: input.event,
          requestId,
          ...input.context,
        }),
      );
      await this.alerts.dispatch({
        // Per-incident key: two different stuck payments alert separately,
        // while repeated emissions for the SAME entity are suppressed.
        key: `${input.event}:${input.identity}`,
        // Money is stuck or mismatched: an administrator must act on it.
        audience: 'business',
        severity: 'critical',
        title: input.title,
        message: input.message,
        context: { ...input.context, incident: input.event, requestId },
      });
    } catch (error) {
      // Never propagate: a throw here would send the outbox event back through
      // its retry path and duplicate the notification on the next pass.
      this.logger.error(
        JSON.stringify({
          event: 'critical_financial_incident_alert_failed',
          incident: input.event,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Provider error strings can be long; keep alerts readable and bounded. */
function truncate(value: string | undefined, max = 300): string | null {
  if (value === undefined) return null;
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
