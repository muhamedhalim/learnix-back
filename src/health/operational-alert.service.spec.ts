import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

import type { MailService } from '../mail/mail.service';
import { AdminNotificationEvent } from '../notifications/constants/admin-notification-events';
import { AdminNotificationCategory } from '../notifications/entities/admin-notification-category.enum';
import { NotificationPriority } from '../notifications/entities/notification-priority.enum';
import type { AdminNotificationsService } from '../notifications/services/admin-notifications.service';
import { OperationalAlertService, type OperationalAlert } from './operational-alert.service';

interface Harness {
  service: OperationalAlertService;
  adminNotifications: { notifyAdmins: jest.Mock };
  mail: { send: jest.Mock; isConfigured: jest.Mock };
  fetchMock: jest.Mock;
}

function buildHarness(env: Record<string, string> = {}): Harness {
  const adminNotifications = { notifyAdmins: jest.fn().mockResolvedValue(undefined) };
  const mail = {
    send: jest.fn().mockResolvedValue(true),
    isConfigured: jest.fn().mockReturnValue(true),
  };
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;

  const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  (globalThis as { fetch: unknown }).fetch = fetchMock;

  const service = new OperationalAlertService(
    adminNotifications as unknown as AdminNotificationsService,
    mail as unknown as MailService,
    config,
  );
  return { service, adminNotifications, mail, fetchMock };
}

const criticalAlert: OperationalAlert = {
  key: 'payment.webhook_dead_letter:evt-1',
  audience: 'business',
  severity: 'critical',
  title: 'Payment webhook dead-lettered',
  message: 'A provider webhook exhausted every attempt.',
  context: { paymentId: 'pay-1', failureCategory: 'webhook_dead_letter' },
};

describe('OperationalAlertService', () => {
  const originalFetch = globalThis.fetch;
  afterAll(() => {
    (globalThis as { fetch: unknown }).fetch = originalFetch;
  });

  describe('in-app delivery (preserved behaviour)', () => {
    it('delivers via the shared admin-notification fan-out, no dedupe key', async () => {
      const { service, adminNotifications } = buildHarness();

      const outcome = await service.dispatch(criticalAlert);

      expect(outcome.inApp).toBe('sent');
      expect(adminNotifications.notifyAdmins).toHaveBeenCalledTimes(1);
      const [event, params] = adminNotifications.notifyAdmins.mock.calls[0] as [
        AdminNotificationEvent,
        Record<string, unknown>,
      ];
      expect(event).toBe(AdminNotificationEvent.OPERATIONAL_ALERT);
      expect(params).toMatchObject({
        priority: NotificationPriority.CRITICAL,
        category: AdminNotificationCategory.FINANCIAL,
        link: '/admin/health',
      });
      expect(params.dedupeKey).toBeUndefined();
    });

    it('categorizes a refund/finance-prefixed alert key as financial', async () => {
      const { service, adminNotifications } = buildHarness();

      await service.dispatch({ ...criticalAlert, key: 'refund.reconciliation_alert:refund-1' });
      await service.dispatch({ ...criticalAlert, key: 'finance.maintenance.repeated_failure:t' });

      for (const call of adminNotifications.notifyAdmins.mock.calls as Array<
        [AdminNotificationEvent, Record<string, unknown>]
      >) {
        expect(call[1]).toMatchObject({ category: AdminNotificationCategory.FINANCIAL });
      }
    });

    it('categorizes a security/auth-prefixed alert key as security', async () => {
      const { service, adminNotifications } = buildHarness();

      await service.dispatch({ ...criticalAlert, key: 'security.brute_force_lockout:user-1' });

      const [, params] = adminNotifications.notifyAdmins.mock.calls[0] as [
        AdminNotificationEvent,
        Record<string, unknown>,
      ];
      expect(params).toMatchObject({ category: AdminNotificationCategory.SECURITY });
    });

    it('maps severity to priority', async () => {
      const { service, adminNotifications } = buildHarness();

      await service.dispatch({ ...criticalAlert, severity: 'warning' });

      const [, params] = adminNotifications.notifyAdmins.mock.calls[0] as [
        AdminNotificationEvent,
        Record<string, unknown>,
      ];
      expect(params).toMatchObject({ priority: NotificationPriority.HIGH });
    });
  });

  describe('technical monitoring alerts never reach the admin inbox', () => {
    const technicalAlert: OperationalAlert = {
      key: 'health-rule:component-degraded:postgresql',
      audience: 'technical',
      severity: 'warning',
      title: 'Component becomes degraded',
      message: 'PostgreSQL: statusRank is 4.00 (threshold 4.00).',
      context: { componentId: 'postgresql', metric: 'statusRank' },
    };

    it.each([
      ['health rule', 'health-rule:component-degraded:postgresql'],
      ['scheduled job', 'scheduled_job.repeated_failure:cleanup'],
      ['queue backlog', 'health-rule:queue-backlog:queue-mail'],
      ['a payment-prefixed key declared technical', 'payment.anything:1'],
    ])('does not create an admin notification for a technical %s alert', async (_label, key) => {
      const { service, adminNotifications } = buildHarness();

      const outcome = await service.dispatch({ ...technicalAlert, key });

      expect(outcome.inApp).toBe('skipped');
      expect(adminNotifications.notifyAdmins).not.toHaveBeenCalled();
    });

    it('does not create an admin notification even when the caller explicitly asks for in-app', async () => {
      const { service, adminNotifications } = buildHarness();

      const outcome = await service.dispatch({
        ...technicalAlert,
        channels: { inApp: true, email: false, webhook: false },
      });

      expect(outcome.inApp).toBe('skipped');
      expect(adminNotifications.notifyAdmins).not.toHaveBeenCalled();
    });

    it('still delivers a technical alert to the external monitoring channels', async () => {
      const { service, mail, fetchMock } = buildHarness({
        ALERT_EMAIL_RECIPIENTS: 'oncall@example.com',
        ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc',
      });

      const outcome = await service.dispatch(technicalAlert);

      expect(outcome).toMatchObject({ inApp: 'skipped', email: 'sent', webhook: 'sent' });
      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(mail.send.mock.calls[0]?.[0]).toMatchObject({
        subject: expect.stringContaining('Component becomes degraded'),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports a business alert whose key has no business prefix as failed instead of silently filing it', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const { service, adminNotifications } = buildHarness();
        // The real AdminNotificationsService throws for this combination.
        adminNotifications.notifyAdmins.mockRejectedValue(new Error('not a business notification'));

        const outcome = await service.dispatch({ ...criticalAlert, key: 'queue.backlog:mail' });

        expect(outcome.inApp).toBe('failed');
        const [, params] = adminNotifications.notifyAdmins.mock.calls[0] as [
          AdminNotificationEvent,
          Record<string, unknown>,
        ];
        expect(params).toMatchObject({ category: AdminNotificationCategory.SYSTEM });
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('external delivery', () => {
    it('emails the configured recipients', async () => {
      const { service, mail } = buildHarness({
        ALERT_EMAIL_RECIPIENTS: 'oncall@example.com, ops@example.com',
      });

      const outcome = await service.dispatch(criticalAlert);

      expect(outcome.email).toBe('sent');
      expect(mail.send).toHaveBeenCalledTimes(2);
      expect(mail.send.mock.calls[0]?.[0]).toMatchObject({ to: 'oncall@example.com' });
    });

    it('ignores malformed recipient entries', async () => {
      const { service, mail } = buildHarness({
        ALERT_EMAIL_RECIPIENTS: 'oncall@example.com,,not-an-email, ',
      });

      await service.dispatch(criticalAlert);

      expect(mail.send).toHaveBeenCalledTimes(1);
    });

    it('posts a provider-agnostic payload to the configured webhook', async () => {
      const { service, fetchMock } = buildHarness({
        ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc',
      });

      const outcome = await service.dispatch(criticalAlert);

      expect(outcome.webhook).toBe('sent');
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://hooks.example.com/abc');
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({
        source: 'learnix-backend',
        severity: 'critical',
        key: 'payment.webhook_dead_letter:evt-1',
      });
      // Renders in both Slack-style and Discord-style receivers.
      expect(body.text).toContain('A provider webhook exhausted every attempt.');
      expect(body.content).toBe(body.text);
    });

    it('skips external channels for informational alerts', async () => {
      const { service, mail, fetchMock } = buildHarness({
        ALERT_EMAIL_RECIPIENTS: 'oncall@example.com',
        ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc',
      });

      const outcome = await service.dispatch({ ...criticalAlert, severity: 'info' });

      expect(outcome.email).toBe('skipped');
      expect(outcome.webhook).toBe('skipped');
      expect(mail.send).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('warns loudly when a critical alert has no external destination configured', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const { service } = buildHarness();
        await service.dispatch(criticalAlert);
        expect(warnSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
          'operational_alert_no_external_destination',
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('delivery failure is handled safely', () => {
    it('logs and reports a failed webhook without throwing', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const { service, fetchMock } = buildHarness({
          ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc',
        });
        fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

        const outcome = await service.dispatch(criticalAlert);

        expect(outcome.webhook).toBe('failed');
        const logged = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
        expect(logged).toContain('operational_alert_delivery_failed');
        expect(logged).toContain('ECONNREFUSED');
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('reports a non-2xx webhook response as failed', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const { service, fetchMock } = buildHarness({
          ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc',
        });
        fetchMock.mockResolvedValue({ ok: false, status: 500 });

        const outcome = await service.dispatch(criticalAlert);
        expect(outcome.webhook).toBe('failed');
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('does not let a failing email channel block the webhook channel', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const { service, mail, fetchMock } = buildHarness({
          ALERT_EMAIL_RECIPIENTS: 'oncall@example.com',
          ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc',
        });
        mail.send.mockRejectedValue(new Error('email queue unavailable'));

        const outcome = await service.dispatch(criticalAlert);

        expect(outcome.email).toBe('failed');
        expect(outcome.webhook).toBe('sent');
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('skips email when the mail provider is not configured', async () => {
      const { service, mail } = buildHarness({ ALERT_EMAIL_RECIPIENTS: 'oncall@example.com' });
      mail.isConfigured.mockReturnValue(false);

      const outcome = await service.dispatch(criticalAlert);

      expect(outcome.email).toBe('skipped');
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('never throws even when in-app delivery fails', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const { service, adminNotifications } = buildHarness();
        adminNotifications.notifyAdmins.mockRejectedValue(new Error('db down'));

        await expect(service.dispatch(criticalAlert)).resolves.toBeDefined();
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('repeat suppression', () => {
    it('suppresses external re-delivery of the SAME incident key', async () => {
      const { service, fetchMock } = buildHarness({
        ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc',
      });

      await service.dispatch(criticalAlert);
      const second = await service.dispatch(criticalAlert);

      expect(second.suppressed).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still records the repeat in-app', async () => {
      const { service, adminNotifications } = buildHarness({
        ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc',
      });

      await service.dispatch(criticalAlert);
      const second = await service.dispatch(criticalAlert);

      expect(second.inApp).toBe('sent');
      expect(adminNotifications.notifyAdmins).toHaveBeenCalledTimes(2);
    });

    it('does NOT suppress a different incident of the same type', async () => {
      const { service, fetchMock } = buildHarness({
        ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc',
      });

      await service.dispatch(criticalAlert);
      await service.dispatch({ ...criticalAlert, key: 'payment.webhook_dead_letter:evt-2' });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('respects ALERT_MIN_INTERVAL_SECONDS=0 for operators who want every occurrence', async () => {
      const { service, fetchMock } = buildHarness({
        ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc',
        ALERT_MIN_INTERVAL_SECONDS: '0',
      });

      await service.dispatch(criticalAlert);
      await service.dispatch(criticalAlert);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('payload safety', () => {
    it('carries only the supplied safe context', async () => {
      const { service, fetchMock } = buildHarness({
        ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc',
      });

      await service.dispatch(criticalAlert);

      const body = String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body);
      expect(body).toContain('pay-1');
      expect(body).not.toMatch(/password|token|secret|api[_-]?key/i);
    });
  });
});
