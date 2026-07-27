import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';

import * as admin from 'firebase-admin';
import { DataSource } from 'typeorm';

import { MailService } from '../../mail/mail.service';
import type { HealthIndicator } from '../health-indicator.interface';
import { errorCode, sanitiseMessage } from '../health-sanitizer.util';
import type { HealthCategory, HealthComponentResult } from '../health.types';
import { componentResult } from './indicator-result.util';

interface ProbeResult {
  reachable: boolean;
  authenticated: boolean | null;
  latencyMs: number;
  statusCode: number | null;
  error: string | null;
  rateLimitRemaining: string | null;
}

@Injectable()
export class ExternalProvidersHealthIndicator implements HealthIndicator {
  public readonly id = 'external-providers';
  private cache: { expiresAt: number; results: HealthComponentResult[] } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly mail: MailService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  public async check(force = false): Promise<HealthComponentResult[]> {
    if (!force && this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.results;
    }
    const checks = [
      this.checkFrontend(),
      this.checkAuthentication(),
      this.checkEmail(),
      this.checkEasyKash(),
      this.checkFirebase(),
      this.checkWhatsApp(),
      this.checkTwilio(),
      this.checkBunnyStream(),
      this.checkSentry(),
    ];
    const results = await Promise.all(checks);
    const intervalMs =
      Number(this.config.get<string>('HEALTH_PROVIDER_CHECK_INTERVAL_MS')) || 300_000;
    this.cache = { results, expiresAt: Date.now() + intervalMs };
    return results;
  }

  private async checkFrontend(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const url = this.config.get<string>('FRONTEND_URL') ?? '';
    if (url === '') {
      return this.misconfigured(
        'frontend-web',
        'Learnix frontend',
        'application',
        startedAt,
        'FRONTEND_URL is not configured, so backend-to-frontend reachability cannot be monitored.',
        false,
      );
    }
    const probe = await this.probe(url, { method: 'HEAD' }, false);
    const result = this.fromProbe({
      id: 'frontend-web',
      name: 'Learnix frontend',
      category: 'application',
      purpose: 'Administrator and learner web application',
      startedAt,
      probe,
      metadata: {
        configuredOrigin: this.safeOrigin(url),
        environment: this.environmentForUrl(url),
      },
      dependencies: ['backend-api'],
      critical: true,
    });
    if (
      this.config.get<string>('NODE_ENV') === 'production' &&
      this.environmentForUrl(url) !== 'production'
    ) {
      result.status = 'warning';
      result.warnings.push(
        'Production is configured with a localhost, sandbox, staging, or test frontend URL.',
      );
    }
    return result;
  }

  private async checkAuthentication(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const jwtConfigured = Boolean(this.config.get<string>('JWT_SECRET'));
    const refreshConfigured = Boolean(this.config.get<string>('JWT_REFRESH_SECRET'));
    const cookieConfigured =
      Boolean(this.config.get<string>('COOKIE_SECRET')) ||
      this.config.get<string>('NODE_ENV') !== 'production';
    const healthy = jwtConfigured && refreshConfigured && cookieConfigured;
    return componentResult({
      id: 'jwt-authentication',
      name: 'Learnix authentication',
      category: 'authentication',
      status: healthy ? 'healthy' : 'misconfigured',
      startedAt,
      message: healthy
        ? 'JWT, refresh-token, cookie, and role guard configuration is loaded.'
        : 'Required authentication configuration is incomplete.',
      metadata: {
        jwtConfigured,
        refreshTokenConfigured: refreshConfigured,
        secureCookieConfiguration: cookieConfigured,
        provider: 'Learnix JWT + Firebase bearer fallback',
      },
      errorCode: healthy ? null : 'AUTH_CONFIGURATION_INCOMPLETE',
      recommendation: healthy
        ? null
        : 'Configure JWT, refresh-token, and production cookie secrets.',
      dependencies: ['postgresql', 'backend-api'],
      critical: true,
    });
  }

  private async checkEmail(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    if (!this.mail.isConfigured()) {
      return this.misconfigured(
        'smtp-email',
        'Email delivery',
        'provider',
        startedAt,
        'SMTP is not configured; production email delivery is unavailable.',
        true,
      );
    }
    try {
      await this.mail.verifyConnectivity();
      return componentResult({
        id: 'smtp-email',
        name: 'Email delivery',
        category: 'provider',
        status: 'healthy',
        startedAt,
        message: 'SMTP connection and authentication handshake succeeded.',
        metadata: {
          purpose: 'Transactional and administrative email',
          configured: true,
          host: this.config.get<string>('SMTP_HOST') ?? null,
          port: this.config.get<number>('SMTP_PORT') ?? 587,
          secure:
            this.config.get<string>('SMTP_SECURE') === 'true' ||
            this.config.get<number>('SMTP_PORT') === 465,
        },
        dependencies: ['backend-api'],
      });
    } catch (error) {
      return this.failed(
        'smtp-email',
        'Email delivery',
        'provider',
        startedAt,
        error,
        'Verify SMTP host, port, TLS mode, credentials, and provider status.',
      );
    }
  }

  private async checkEasyKash(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const apiUrl = this.config.get<string>('EASYKASH_API_URL') ?? '';
    const apiKey = this.config.get<string>('EASYKASH_API_KEY') ?? '';
    const hmac = this.config.get<string>('EASYKASH_HMAC_SECRET') ?? '';
    if (apiUrl === '' && apiKey === '' && hmac === '') {
      return this.misconfigured(
        'easykash',
        'EasyKash payments',
        'provider',
        startedAt,
        'EasyKash is installed but not configured.',
        true,
      );
    }
    if (apiUrl === '' || apiKey === '' || hmac === '') {
      return this.misconfigured(
        'easykash',
        'EasyKash payments',
        'provider',
        startedAt,
        'EasyKash configuration is incomplete.',
        true,
      );
    }

    const probe = await this.probe(apiUrl, { method: 'HEAD' }, false);
    const recent = await this.recentProviderTraffic('easykash');
    const result = this.fromProbe({
      id: 'easykash',
      name: 'EasyKash payments',
      category: 'provider',
      purpose: 'Hosted checkout and payment webhooks',
      startedAt,
      probe,
      metadata: {
        environment: this.environmentForUrl(apiUrl),
        origin: this.safeOrigin(apiUrl),
        authenticationValidity:
          recent.successes > 0 ? 'verified_by_recent_webhook' : 'not_safely_testable',
        recentSuccesses: recent.successes,
        recentFailures: recent.failures,
        recentSuccessRatePercent: recent.successRate,
        lastSuccessfulRequest: recent.lastSuccess,
        lastFailure: recent.lastFailure,
      },
      dependencies: ['backend-api', 'postgresql'],
      critical: true,
    });
    if (recent.successes === 0 && result.status === 'healthy') {
      result.status = 'warning';
      result.warnings.push(
        'Connectivity is confirmed, but authentication cannot be tested without creating a payment; no recent successful webhook is available.',
      );
    }
    if (
      this.config.get<string>('NODE_ENV') === 'production' &&
      this.environmentForUrl(apiUrl) !== 'production'
    ) {
      result.status = 'warning';
      result.warnings.push(
        'Production is configured with a sandbox, staging, test, or local payment endpoint.',
      );
    }
    return result;
  }

  private async checkFirebase(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID') ?? '';
    const email = this.config.get<string>('FIREBASE_CLIENT_EMAIL') ?? '';
    const key = this.config.get<string>('FIREBASE_PRIVATE_KEY') ?? '';
    if (projectId === '' && email === '' && key === '') {
      return this.misconfigured(
        'firebase',
        'Firebase authentication',
        'authentication',
        startedAt,
        'Firebase is installed but not configured; Firebase bearer authentication is disabled.',
        false,
      );
    }
    if (projectId === '' || email === '' || key === '') {
      return this.misconfigured(
        'firebase',
        'Firebase authentication',
        'authentication',
        startedAt,
        'Firebase service-account configuration is incomplete.',
        false,
      );
    }
    try {
      const app = admin.apps[0];
      if (!app) throw new Error('Firebase application did not initialise');
      await app.auth().listUsers(1);
      return componentResult({
        id: 'firebase',
        name: 'Firebase authentication',
        category: 'authentication',
        status: 'healthy',
        startedAt,
        message: 'Firebase Admin API authentication and read connectivity succeeded.',
        metadata: {
          purpose: 'Bearer-token authentication',
          projectId: this.maskIdentifier(projectId),
          configured: true,
          authenticationValidity: 'verified',
        },
        dependencies: ['backend-api'],
      });
    } catch (error) {
      return this.failed(
        'firebase',
        'Firebase authentication',
        'authentication',
        startedAt,
        error,
        'Verify the Firebase service account, project state, IAM permissions, and outbound access.',
      );
    }
  }

  private async checkWhatsApp(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const phoneId = this.config.get<string>('META_WHATSAPP_PHONE_NUMBER_ID') ?? '';
    const token = this.config.get<string>('META_WHATSAPP_ACCESS_TOKEN') ?? '';
    if (phoneId === '' && token === '') {
      return this.misconfigured(
        'meta-whatsapp',
        'Meta WhatsApp',
        'provider',
        startedAt,
        'Meta WhatsApp is installed but not configured; SMS remains the fallback.',
        false,
      );
    }
    if (phoneId === '' || token === '') {
      return this.misconfigured(
        'meta-whatsapp',
        'Meta WhatsApp',
        'provider',
        startedAt,
        'Meta WhatsApp configuration is incomplete.',
        false,
      );
    }
    const probe = await this.probe(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}?fields=id`,
      { headers: { Authorization: `Bearer ${token}` } },
      true,
    );
    return this.fromProbe({
      id: 'meta-whatsapp',
      name: 'Meta WhatsApp',
      category: 'provider',
      purpose: 'Guardian WhatsApp notifications',
      startedAt,
      probe,
      metadata: { phoneNumberId: this.maskIdentifier(phoneId), environment: 'production_api' },
      dependencies: ['backend-api', 'queue-parent-notifications'],
      critical: false,
    });
  }

  private async checkTwilio(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const sid = this.config.get<string>('TWILIO_ACCOUNT_SID') ?? '';
    const token = this.config.get<string>('TWILIO_AUTH_TOKEN') ?? '';
    const from = this.config.get<string>('TWILIO_PHONE_NUMBER') ?? '';
    if (sid === '' && token === '' && from === '') {
      return this.misconfigured(
        'twilio-sms',
        'Twilio SMS',
        'provider',
        startedAt,
        'Twilio is installed but not configured; SMS fallback is unavailable.',
        false,
      );
    }
    if (sid === '' || token === '' || from === '') {
      return this.misconfigured(
        'twilio-sms',
        'Twilio SMS',
        'provider',
        startedAt,
        'Twilio configuration is incomplete.',
        false,
      );
    }
    const basic = Buffer.from(`${sid}:${token}`).toString('base64');
    const probe = await this.probe(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`,
      { headers: { Authorization: `Basic ${basic}` } },
      true,
    );
    return this.fromProbe({
      id: 'twilio-sms',
      name: 'Twilio SMS',
      category: 'provider',
      purpose: 'Guardian SMS fallback',
      startedAt,
      probe,
      metadata: {
        account: this.maskIdentifier(sid),
        sender: this.maskIdentifier(from),
        environment: sid.startsWith('AC') ? 'production_api' : 'unknown',
      },
      dependencies: ['backend-api', 'queue-parent-notifications'],
      critical: false,
    });
  }

  private async checkBunnyStream(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const libraryId = this.config.get<string>('BUNNY_STREAM_LIBRARY_ID') ?? '';
    const apiKey =
      this.config.get<string>('BUNNY_STREAM_API_KEY') ??
      this.config.get<string>('BUNNY_API_KEY') ??
      '';
    if (libraryId === '' && apiKey === '') {
      return this.misconfigured(
        'bunny-stream',
        'Bunny Stream',
        'provider',
        startedAt,
        'Bunny Stream is installed but not configured; video operations are unavailable.',
        false,
      );
    }
    if (libraryId === '' || apiKey === '') {
      return this.misconfigured(
        'bunny-stream',
        'Bunny Stream',
        'provider',
        startedAt,
        'Bunny Stream configuration is incomplete.',
        false,
      );
    }
    const probe = await this.probe(
      `https://video.bunnycdn.com/library/${encodeURIComponent(libraryId)}/videos?page=1&itemsPerPage=1`,
      { headers: { AccessKey: apiKey } },
      true,
    );
    return this.fromProbe({
      id: 'bunny-stream',
      name: 'Bunny Stream',
      category: 'provider',
      purpose: 'Lesson video hosting and playback',
      startedAt,
      probe,
      metadata: {
        libraryId: this.maskIdentifier(libraryId),
        signedPlaybackConfigured: Boolean(this.config.get<string>('BUNNY_STREAM_TOKEN_KEY')),
        cdnHostConfigured: Boolean(
          this.config.get<string>('BUNNY_STREAM_CDN_HOSTNAME') ??
          this.config.get<string>('BUNNY_STREAM_PULL_ZONE'),
        ),
      },
      dependencies: ['backend-api'],
      critical: false,
    });
  }

  private async checkSentry(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const dsn = this.config.get<string>('SENTRY_DSN') ?? '';
    if (dsn === '') {
      return this.misconfigured(
        'sentry',
        'Sentry monitoring',
        'monitoring',
        startedAt,
        'Sentry is installed but not configured; external error monitoring is disabled.',
        false,
      );
    }
    return componentResult({
      id: 'sentry',
      name: 'Sentry monitoring',
      category: 'monitoring',
      status: 'warning',
      startedAt,
      message:
        'Sentry is initialised, but delivery cannot be verified safely without emitting a synthetic error.',
      metadata: {
        configured: true,
        release: this.config.get<string>('SENTRY_RELEASE') ?? null,
        traceSampleRate: this.config.get<number>('SENTRY_TRACES_SAMPLE_RATE') ?? null,
        environment: this.config.get<string>('NODE_ENV') ?? 'development',
      },
      warnings: ['Use the Sentry project monitor to confirm event ingestion and alert delivery.'],
      dependencies: ['backend-api'],
    });
  }

  private fromProbe(input: {
    id: string;
    name: string;
    category: HealthCategory;
    purpose: string;
    startedAt: number;
    probe: ProbeResult;
    metadata: Record<string, unknown>;
    dependencies: string[];
    critical: boolean;
  }): HealthComponentResult {
    const status = !input.probe.reachable
      ? 'down'
      : input.probe.authenticated === false
        ? 'degraded'
        : input.probe.latencyMs >= 2_000
          ? 'degraded'
          : input.probe.latencyMs >= 750
            ? 'warning'
            : 'healthy';
    return {
      ...componentResult({
        id: input.id,
        name: input.name,
        category: input.category,
        status,
        startedAt: input.startedAt,
        message:
          status === 'healthy'
            ? input.probe.authenticated === null
              ? `${input.purpose} endpoint is reachable; authentication is not exercised by this safe probe.`
              : `${input.purpose} provider is reachable and authenticated.`
            : (input.probe.error ?? `${input.purpose} provider returned an unhealthy response.`),
        metadata: {
          purpose: input.purpose,
          configured: true,
          connectivity: input.probe.reachable,
          authenticationValidity:
            input.probe.authenticated === null ? 'not_safely_testable' : input.probe.authenticated,
          statusCode: input.probe.statusCode,
          rateLimitRemaining: input.probe.rateLimitRemaining,
          ...input.metadata,
        },
        errorCode:
          status === 'healthy' ? null : `PROVIDER_${input.id.toUpperCase().replaceAll('-', '_')}`,
        recommendation:
          status === 'healthy'
            ? null
            : 'Verify provider status, credentials, account state, rate limits, and outbound network access.',
        dependencies: input.dependencies,
        critical: input.critical,
      }),
      latencyMs: input.probe.latencyMs,
    };
  }

  private misconfigured(
    id: string,
    name: string,
    category: HealthCategory,
    startedAt: number,
    message: string,
    critical: boolean,
  ): HealthComponentResult {
    return componentResult({
      id,
      name,
      category,
      status: 'misconfigured',
      startedAt,
      message,
      metadata: { configured: false },
      errorCode: `${id.toUpperCase().replaceAll('-', '_')}_NOT_CONFIGURED`,
      recommendation: `Configure ${name} only if this capability is enabled in this environment.`,
      dependencies: ['backend-api'],
      critical,
    });
  }

  private failed(
    id: string,
    name: string,
    category: HealthCategory,
    startedAt: number,
    error: unknown,
    recommendation: string,
  ): HealthComponentResult {
    return componentResult({
      id,
      name,
      category,
      status: 'down',
      startedAt,
      message: sanitiseMessage(error),
      metadata: { configured: true, connectivity: false },
      errorCode: errorCode(error, `${id}_UNAVAILABLE`),
      recommendation,
      dependencies: ['backend-api'],
    });
  }

  private async probe(
    url: string,
    init: RequestInit,
    authenticationExpected: boolean,
  ): Promise<ProbeResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    timer.unref();
    try {
      const response = await fetch(url, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });
      const statusCode = response.status;
      return {
        reachable: true,
        authenticated: authenticationExpected ? statusCode !== 401 && statusCode !== 403 : null,
        latencyMs: Date.now() - startedAt,
        statusCode,
        error: statusCode >= 500 ? `Provider returned HTTP ${statusCode.toString()}.` : null,
        rateLimitRemaining:
          response.headers.get('x-ratelimit-remaining') ??
          response.headers.get('x-rate-limit-remaining'),
      };
    } catch (error) {
      return {
        reachable: false,
        authenticated: authenticationExpected ? false : null,
        latencyMs: Date.now() - startedAt,
        statusCode: null,
        error: sanitiseMessage(error),
        rateLimitRemaining: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async recentProviderTraffic(provider: string): Promise<{
    successes: number;
    failures: number;
    successRate: number | null;
    lastSuccess: string | null;
    lastFailure: string | null;
  }> {
    try {
      const rows = await this.dataSource.query<
        Array<{
          successes: string;
          failures: string;
          last_success: Date | null;
          last_failure: Date | null;
        }>
      >(
        `SELECT
          count(*) FILTER (WHERE status = 'processed')::text AS successes,
          count(*) FILTER (WHERE status = 'failed')::text AS failures,
          max(created_at) FILTER (WHERE status = 'processed') AS last_success,
          max(created_at) FILTER (WHERE status = 'failed') AS last_failure
        FROM gateway_webhook_events
        WHERE provider = $1 AND created_at >= now() - interval '24 hours'`,
        [provider],
      );
      const row = rows[0];
      const successes = Number(row?.successes ?? 0);
      const failures = Number(row?.failures ?? 0);
      return {
        successes,
        failures,
        successRate:
          successes + failures === 0
            ? null
            : Math.round((successes / (successes + failures)) * 10_000) / 100,
        lastSuccess: row?.last_success?.toISOString() ?? null,
        lastFailure: row?.last_failure?.toISOString() ?? null,
      };
    } catch {
      return {
        successes: 0,
        failures: 0,
        successRate: null,
        lastSuccess: null,
        lastFailure: null,
      };
    }
  }

  private maskIdentifier(value: string): string {
    if (value.length <= 6) return '***';
    return `${value.slice(0, 3)}…${value.slice(-3)}`;
  }

  private safeOrigin(value: string): string | null {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  }

  private environmentForUrl(value: string): string {
    const lower = value.toLowerCase();
    if (lower.includes('localhost') || lower.includes('127.0.0.1')) return 'local';
    if (/(sandbox|staging|test|dev)/u.test(lower)) return 'sandbox';
    return 'production';
  }
}
