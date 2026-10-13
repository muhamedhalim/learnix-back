import { Logger } from '@nestjs/common';

import * as Sentry from '@sentry/node';

import { resolveAppEnvLabel } from '../config/app-env';
import { processEnvReader } from '../common/utils/redis-connection.util';
import { performanceMetrics } from './performance-metrics.registry';
import { resolveRelease } from './release';

const logger = new Logger('Sentry');

let initialized = false;

/**
 * Errors already reported to Sentry, so the same object can never be sent twice.
 *
 * A handled exception is captured by `HttpExceptionFilter`; if that same object
 * later escapes to `uncaughtException`/`unhandledRejection` (a background
 * continuation of a request that already responded, for example), the process
 * handler must not report it again. A WeakSet keeps this free of leaks —
 * entries disappear with the error object.
 */
const reportedErrors = new WeakSet<object>();

/** Header names that may never leave the process, whatever Sentry collected. */
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-csrf-token',
  'x-api-key',
  'x-auth-token',
  'x-hub-signature',
  'x-hub-signature-256',
]);

/** Query-string parameter names whose values are replaced with `[redacted]`. */
const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'password',
  'secret',
  'api_key',
  'apikey',
  'key',
  'signature',
  'hmac',
  'code',
]);

/** The structural slice of a Sentry event this module touches. */
interface ScrubbableEvent {
  request?: {
    data?: unknown;
    cookies?: unknown;
    headers?: Record<string, unknown>;
    query_string?: unknown;
    url?: unknown;
  };
  user?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
}

function redactQueryString(value: string): string {
  return value
    .split('&')
    .map((pair) => {
      const separator = pair.indexOf('=');
      if (separator === -1) return pair;
      const key = pair.slice(0, separator);
      return SENSITIVE_QUERY_KEYS.has(key.toLowerCase()) ? `${key}=[redacted]` : pair;
    })
    .join('&');
}

/**
 * Strip everything that could carry a credential or personal data before an
 * event leaves the process.
 *
 * `sendDefaultPii: false` already suppresses most of this, but that flag is a
 * default the SDK applies — this is an explicit, unit-tested guarantee that
 * request bodies, cookies, authorization headers, API keys and query-string
 * tokens are gone regardless of SDK version or integration behaviour.
 *
 * Exported (and pure) so the guarantee is directly testable.
 */
export function scrubSentryEvent<T extends ScrubbableEvent>(event: T): T {
  const request = event.request;
  if (request) {
    // Request bodies may contain passwords, payment details, or exam answers.
    // There is no safe subset, so the whole body goes.
    delete request.data;
    delete request.cookies;

    if (request.headers && typeof request.headers === 'object') {
      for (const name of Object.keys(request.headers)) {
        if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
          delete request.headers[name];
        }
      }
    }

    if (typeof request.query_string === 'string') {
      request.query_string = redactQueryString(request.query_string);
    }
    if (typeof request.url === 'string' && request.url.includes('?')) {
      const [path = '', query = ''] = request.url.split('?');
      request.url = `${path}?${redactQueryString(query)}`;
    }
  }

  if (event.user) {
    // The user id and role are the useful, non-identifying dimensions. Contact
    // details and network identifiers are not sent.
    delete event.user['email'];
    delete event.user['username'];
    delete event.user['ip_address'];
    delete event.user['phone'];
  }

  return event;
}

/**
 * Whether Sentry should initialise at all.
 *
 * `SENTRY_ENABLED` is an explicit operator kill-switch: setting it to `false`
 * disables monitoring even when a DSN is present. Previously this variable was
 * validated, documented, and read by the health indicator, but `initSentry`
 * keyed only on the DSN — so `SENTRY_ENABLED=false` produced a process that
 * reported to Sentry while the health dashboard said Sentry was disabled. The
 * indicator's semantics are now the SDK's semantics.
 *
 * Any value other than the exact string `'false'` leaves the previous
 * DSN-only behaviour untouched, so existing deployments are unaffected.
 */
export function isSentryConfigured(get: (key: string) => string | undefined): boolean {
  if (get('SENTRY_ENABLED') === 'false') return false;
  const dsn = get('SENTRY_DSN');
  return dsn !== undefined && dsn !== '';
}

/**
 * Initialise Sentry error + performance monitoring.
 *
 * Must be called as early as possible (before the Nest app is created) so the
 * SDK can auto-instrument HTTP, Postgres, Redis, etc. Sentry v8 tracing is built
 * on OpenTelemetry, so this also provides distributed request tracing.
 *
 * A no-op when `SENTRY_DSN` is unset or `SENTRY_ENABLED=false` — the app runs
 * identically without it, so local/dev and CI need no Sentry account.
 */
export function initSentry(): void {
  const read = processEnvReader();

  if (read('SENTRY_ENABLED') === 'false') {
    logger.log('SENTRY_ENABLED=false — error monitoring disabled.');
    return;
  }

  const dsn = read('SENTRY_DSN');
  if (dsn === undefined || dsn === '') {
    logger.log('SENTRY_DSN not set — error monitoring disabled.');
    return;
  }

  const release = resolveRelease(read);
  // On AWS the ADOT auto-instrumentation (NODE_OPTIONS --require .../autoinstrumentation.js) owns the
  // global OpenTelemetry tracer provider and sends traces to X-Ray. Sentry v8 would register a second
  // one; during the Sentry parity window it therefore captures errors only and leaves tracing to ADOT.
  const adotActive = isAdotTracingActive(read);
  Sentry.init({
    dsn,
    // APP_ENV, not NODE_ENV: staging deliberately runs NODE_ENV=production (it
    // needs every protection that flag turns on — see config/app-env.ts), so
    // tagging on NODE_ENV would label every staging error "production" and
    // either bury real production alerts in staging noise or get a
    // staging-only error triaged as a live incident. See docs/NODE_ENV_AUDIT.md.
    environment: resolveAppEnvLabel(read),
    // Only set release when one is resolvable (exactOptionalPropertyTypes).
    // Falls back through APP_VERSION and the platform commit SHA, so a Railway
    // deployment is release-tagged with no extra configuration — see release.ts.
    ...(release !== undefined ? { release } : {}),
    // Sampling is env-tunable; default to a low trace rate to control volume.
    ...(adotActive
      ? { skipOpenTelemetrySetup: true, tracesSampleRate: 0 }
      : { tracesSampleRate: Number(read('SENTRY_TRACES_SAMPLE_RATE') ?? '0.1') }),
    // Never let PII leave the process — request bodies/headers are scrubbed.
    sendDefaultPii: false,
    beforeSend: (event) => scrubSentryEvent(event),
  });

  initialized = true;
  logger.log(
    release === undefined
      ? 'Sentry initialised (no release identifier resolved).'
      : `Sentry initialised (release ${release}).`,
  );
}

/** True when the AWS Distro for OpenTelemetry agent instruments this process (Application Signals). */
export function isAdotTracingActive(read: (key: string) => string | undefined): boolean {
  return (
    read('OTEL_AWS_APPLICATION_SIGNALS_ENABLED') === 'true' ||
    /autoinstrumentation/u.test(read('NODE_OPTIONS') ?? '')
  );
}

export function isSentryEnabled(): boolean {
  return initialized;
}

/** Test seam: reset module state between unit tests. Never called at runtime. */
export function resetSentryStateForTesting(): void {
  initialized = false;
}

export interface HandledExceptionContext {
  requestId: string;
  method: string;
  route: string;
  status: number;
  userId?: string | undefined;
  role?: string | undefined;
}

/**
 * Report a server-side exception that the global exception filter already
 * handled.
 *
 * Without this, a NestJS exception filter is a blind spot: it produces the HTTP
 * response itself, so the error never propagates to Express's error chain and
 * the SDK's automatic instrumentation never observes it. Only process-level
 * crashes reached Sentry — i.e. ordinary production 500s did not.
 *
 * Only the safe, high-value dimensions are attached: the correlation id, the
 * matched route pattern (never the raw URL, which can carry ids), the method
 * and status, and the authenticated principal's id and role. No bodies,
 * headers, cookies or tokens — `beforeSend` enforces that independently.
 */
export function captureHandledException(
  exception: unknown,
  context: HandledExceptionContext,
): void {
  if (!initialized) return;
  if (!markReported(exception)) return;

  Sentry.withScope((scope) => {
    scope.setTag('request_id', context.requestId);
    scope.setTag('route', context.route);
    scope.setTag('http_method', context.method);
    scope.setTag('http_status', String(context.status));
    scope.setTag('handled', 'true');
    scope.setContext('request_summary', {
      requestId: context.requestId,
      method: context.method,
      route: context.route,
      status: context.status,
    });
    if (context.userId !== undefined) {
      scope.setUser({
        id: context.userId,
        ...(context.role === undefined ? {} : { role: context.role }),
      });
    }
    scope.setLevel('error');
    Sentry.captureException(exception);
  });
}

/**
 * Records `error` as reported and returns whether this is the first report.
 * Non-object throwables (a rejected string, say) cannot be tracked in a
 * WeakSet, so they are always reported — Sentry's own `dedupeIntegration` is
 * the backstop there.
 */
function markReported(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return true;
  if (reportedErrors.has(error)) return false;
  reportedErrors.add(error);
  return true;
}

/**
 * Register handlers for otherwise-fatal process events so they are recorded
 * (metrics + Sentry) instead of silently crashing the worker. Errors are logged
 * but the process is NOT force-exited here — the platform's restart policy owns
 * lifecycle decisions.
 */
export function registerGlobalErrorHandlers(): void {
  process.on('unhandledRejection', (reason: unknown) => {
    performanceMetrics.recordFailure('unhandled_rejection');
    logger.error(
      `Unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
      reason instanceof Error ? reason.stack : undefined,
    );
    if (initialized && markReported(reason)) {
      Sentry.captureException(reason);
    }
  });

  process.on('uncaughtException', (error: Error) => {
    performanceMetrics.recordFailure('unhandled_exception');
    logger.error(`Uncaught exception: ${error.message}`, error.stack);
    if (initialized && markReported(error)) {
      Sentry.captureException(error);
    }
  });
}
