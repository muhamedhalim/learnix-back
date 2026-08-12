import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { processEnvReader } from '../common/utils/redis-connection.util';
import { resolveAppEnvLabel } from '../config/app-env';
import { MailService } from '../mail/mail.service';
import { NotificationType } from '../notifications/entities/notification-type.enum';
import { NotificationOrigin } from '../notifications/entities/notification-origin.enum';
import { NotificationsService } from '../notifications/services/notifications.service';
import { resolveRelease } from '../observability/release';
import { UserRole } from '../users/entities/user-role.enum';
import { User } from '../users/entities/user.entity';

export type AlertSeverity = 'critical' | 'warning' | 'info';

/** Only safe, non-identifying diagnostic values may travel in an alert. */
export type AlertContext = Record<string, string | number | boolean | null>;

export interface OperationalAlert {
  /**
   * Stable identity of THIS incident (e.g. `payment.webhook_dead_letter:<id>`).
   * Used to suppress repeats of the same incident, so it must be specific
   * enough that two genuinely different incidents never share a key.
   */
  key: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  context?: AlertContext;
  /** Extra addresses on top of `ALERT_EMAIL_RECIPIENTS` (e.g. per-rule ones). */
  additionalEmailRecipients?: string[];
  /** Defaults: in-app always; email + webhook for `critical` and `warning`. */
  channels?: { inApp?: boolean; email?: boolean; webhook?: boolean };
}

export interface AlertDeliveryOutcome {
  inApp: 'sent' | 'skipped' | 'failed';
  email: 'sent' | 'skipped' | 'failed';
  webhook: 'sent' | 'skipped' | 'failed';
  suppressed: boolean;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DEFAULT_MIN_INTERVAL_SECONDS = 900;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;
const MAX_TRACKED_KEYS = 2_000;
const MAX_ADMIN_RECIPIENTS = 100;

/**
 * The single delivery path for operational alerts.
 *
 * This is deliberately NOT a second rule engine — `HealthAlertService` remains
 * the only place thresholds, hysteresis and cooldowns live. This class answers
 * one question: given that something has already been decided to be an
 * incident, how does a human find out?
 *
 * Before this existed, every alert rule was seeded with `channels: ['in_app']`
 * and an empty recipient list, so a production incident produced a
 * notification row and nothing else — an admin had to already be looking at
 * the dashboard. Two independent external paths are added here, both
 * environment-driven and both optional:
 *
 *   - `ALERT_EMAIL_RECIPIENTS` — reuses the existing MailerSend + BullMQ
 *     pipeline (`MailService`), which is already the production email path.
 *   - `ALERT_WEBHOOK_URL` — a single provider-agnostic JSON POST. No vendor
 *     SDK is added; the payload carries `text` and `content` alongside the
 *     structured fields so a Slack- or Discord-style incoming webhook renders
 *     it without any provider-specific integration.
 *
 * With neither configured, behaviour is exactly as before (in-app only), so
 * this is safe to deploy ahead of the operator choosing a destination.
 */
@Injectable()
export class OperationalAlertService {
  private readonly logger = new Logger(OperationalAlertService.name);
  /** Last external delivery per incident key, for repeat suppression. */
  private readonly lastDeliveredAt = new Map<string, number>();
  /**
   * Re-entrancy guard. Delivering an alert can itself fail (the email queue is
   * down, the webhook host is unreachable). Those failures are LOGGED, never
   * turned into another alert — this flag makes that structurally impossible
   * even if a future caller wires one up by mistake.
   */
  private delivering = false;

  public constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  public async dispatch(alert: OperationalAlert): Promise<AlertDeliveryOutcome> {
    const outcome: AlertDeliveryOutcome = {
      inApp: 'skipped',
      email: 'skipped',
      webhook: 'skipped',
      suppressed: false,
    };

    if (this.delivering) {
      // Reached only if alert delivery itself tried to raise an alert.
      this.logger.warn(
        JSON.stringify({
          event: 'operational_alert_recursion_blocked',
          alertKey: alert.key,
        }),
      );
      outcome.suppressed = true;
      return outcome;
    }

    const external = alert.severity !== 'info';
    const wantsEmail = alert.channels?.email ?? external;
    const wantsWebhook = alert.channels?.webhook ?? external;
    const wantsInApp = alert.channels?.inApp ?? true;

    // Suppression applies only to the external channels: the in-app feed is a
    // durable record and should always reflect every occurrence.
    const suppressExternal = this.isSuppressed(alert.key);
    outcome.suppressed = suppressExternal;

    this.delivering = true;
    try {
      if (wantsInApp) {
        outcome.inApp = await this.deliverInApp(alert);
      }
      if (wantsEmail && !suppressExternal) {
        outcome.email = await this.deliverEmail(alert);
      }
      if (wantsWebhook && !suppressExternal) {
        outcome.webhook = await this.deliverWebhook(alert);
      }
    } finally {
      this.delivering = false;
    }

    if (!suppressExternal && (outcome.email !== 'skipped' || outcome.webhook !== 'skipped')) {
      this.markDelivered(alert.key);
    }

    if (
      external &&
      outcome.email === 'skipped' &&
      outcome.webhook === 'skipped' &&
      !suppressExternal
    ) {
      // Loud, once per incident: a critical alert that only reached the
      // dashboard is the exact failure mode this service exists to prevent.
      this.logger.warn(
        JSON.stringify({
          event: 'operational_alert_no_external_destination',
          alertKey: alert.key,
          severity: alert.severity,
          hint: 'Set ALERT_EMAIL_RECIPIENTS and/or ALERT_WEBHOOK_URL so critical alerts reach a human.',
        }),
      );
    }

    return outcome;
  }

  /** True when this exact incident was already delivered externally recently. */
  private isSuppressed(key: string): boolean {
    const last = this.lastDeliveredAt.get(key);
    if (last === undefined) return false;
    return Date.now() - last < this.minIntervalMs();
  }

  private markDelivered(key: string): void {
    // Bounded: evict the oldest entries rather than growing without limit.
    if (this.lastDeliveredAt.size >= MAX_TRACKED_KEYS) {
      const cutoff = Date.now() - this.minIntervalMs();
      for (const [existing, at] of this.lastDeliveredAt) {
        if (at < cutoff) this.lastDeliveredAt.delete(existing);
      }
      if (this.lastDeliveredAt.size >= MAX_TRACKED_KEYS) {
        const oldest = this.lastDeliveredAt.keys().next();
        if (!oldest.done) this.lastDeliveredAt.delete(oldest.value);
      }
    }
    this.lastDeliveredAt.set(key, Date.now());
  }

  private minIntervalMs(): number {
    const raw = this.config.get<string>('ALERT_MIN_INTERVAL_SECONDS');
    if (raw === undefined || String(raw).trim() === '') {
      return DEFAULT_MIN_INTERVAL_SECONDS * 1_000;
    }
    const configured = Number(raw);
    // `0` is meaningful — an operator asking for every occurrence, no
    // suppression — so it must not be treated as "unset" and fall back to the
    // 15-minute default.
    return Number.isFinite(configured) && configured >= 0
      ? configured * 1_000
      : DEFAULT_MIN_INTERVAL_SECONDS * 1_000;
  }

  private async deliverInApp(alert: OperationalAlert): Promise<'sent' | 'failed'> {
    try {
      const admins = await this.users.find({
        where: { role: UserRole.ADMIN, is_active: true },
        select: { id: true },
        take: MAX_ADMIN_RECIPIENTS,
      });
      await Promise.allSettled(
        admins.map(
          async (admin) =>
            await this.notifications.create(
              {
                user_id: admin.id,
                type: NotificationType.CUSTOM,
                title: this.subject(alert),
                message: alert.message,
                data: { alertKey: alert.key, severity: alert.severity, ...(alert.context ?? {}) },
              },
              false,
              {
                origin: NotificationOrigin.OPERATIONAL,
                sourceEvent: alert.key.slice(0, 120),
              },
            ),
        ),
      );
      return 'sent';
    } catch (error) {
      this.logFailure('in_app', alert, error);
      return 'failed';
    }
  }

  private async deliverEmail(alert: OperationalAlert): Promise<'sent' | 'skipped' | 'failed'> {
    const recipients = this.emailRecipients(alert);
    if (recipients.length === 0) return 'skipped';
    if (!this.mail.isConfigured()) {
      this.logger.warn(
        JSON.stringify({
          event: 'operational_alert_email_unavailable',
          alertKey: alert.key,
          reason: 'MailerSend is not configured',
        }),
      );
      return 'skipped';
    }

    const body = this.plainTextBody(alert);
    const results = await Promise.allSettled(
      recipients.map(
        async (to) =>
          await this.mail.send({
            to,
            subject: this.subject(alert),
            text: body,
            html: `<pre style="font-family:monospace;white-space:pre-wrap">${escapeHtml(body)}</pre>`,
          }),
      ),
    );
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length === results.length) {
      this.logFailure(
        'email',
        alert,
        failed[0]?.status === 'rejected' ? failed[0].reason : 'unknown',
      );
      return 'failed';
    }
    return 'sent';
  }

  private async deliverWebhook(alert: OperationalAlert): Promise<'sent' | 'skipped' | 'failed'> {
    const url = this.config.get<string>('ALERT_WEBHOOK_URL');
    if (url === undefined || url.trim() === '') return 'skipped';

    const configuredTimeout = Number(this.config.get<string>('ALERT_WEBHOOK_TIMEOUT_MS'));
    const timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_WEBHOOK_TIMEOUT_MS;

    const summary = this.plainTextBody(alert);
    const payload = {
      source: 'learnix-backend',
      environment: this.environment(),
      release: resolveRelease(processEnvReader()) ?? null,
      severity: alert.severity,
      key: alert.key,
      title: alert.title,
      message: alert.message,
      context: alert.context ?? {},
      timestamp: new Date().toISOString(),
      // Rendered by Slack-style (`text`) and Discord-style (`content`)
      // incoming webhooks without any vendor-specific integration.
      text: summary,
      content: summary,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logFailure('webhook', alert, `HTTP ${response.status.toString()}`);
        return 'failed';
      }
      return 'sent';
    } catch (error) {
      this.logFailure('webhook', alert, error);
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  }

  private emailRecipients(alert: OperationalAlert): string[] {
    const configured = this.config.get<string>('ALERT_EMAIL_RECIPIENTS') ?? '';
    const combined = [...configured.split(','), ...(alert.additionalEmailRecipients ?? [])];
    const unique = new Set(
      combined.map((value) => value.trim()).filter((value) => EMAIL_PATTERN.test(value)),
    );
    return [...unique].slice(0, 20);
  }

  private subject(alert: OperationalAlert): string {
    return `[${alert.severity.toUpperCase()}][${this.environment()}] ${alert.title}`;
  }

  private plainTextBody(alert: OperationalAlert): string {
    const lines = [alert.message, '', `Environment: ${this.environment()}`, `Alert: ${alert.key}`];
    for (const [key, value] of Object.entries(alert.context ?? {})) {
      lines.push(`${key}: ${String(value)}`);
    }
    return lines.join('\n');
  }

  private environment(): string {
    return resolveAppEnvLabel(this.config.get.bind(this.config));
  }

  /**
   * A delivery failure is LOGGED and never re-alerted. Escalating a failed
   * alert into another alert is how alert storms start, and the failing
   * channel is by definition the one that cannot carry the news.
   */
  private logFailure(channel: string, alert: OperationalAlert, error: unknown): void {
    this.logger.error(
      JSON.stringify({
        event: 'operational_alert_delivery_failed',
        channel,
        alertKey: alert.key,
        severity: alert.severity,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
