import { Logger } from '@nestjs/common';

import * as Sentry from '@sentry/node';

import { performanceMetrics } from './performance-metrics.registry';

const logger = new Logger('Sentry');

let initialized = false;

/**
 * Initialise Sentry error + performance monitoring.
 *
 * Must be called as early as possible (before the Nest app is created) so the
 * SDK can auto-instrument HTTP, Postgres, Redis, etc. Sentry v8 tracing is built
 * on OpenTelemetry, so this also provides distributed request tracing.
 *
 * A no-op when `SENTRY_DSN` is unset — the app runs identically without it, so
 * local/dev and CI need no Sentry account.
 */
export function initSentry(): void {
  const dsn = process.env['SENTRY_DSN'];
  if (dsn === undefined || dsn === '') {
    logger.log('SENTRY_DSN not set — error monitoring disabled.');
    return;
  }

  const release = process.env['SENTRY_RELEASE'];
  Sentry.init({
    dsn,
    environment: process.env['NODE_ENV'] ?? 'development',
    // Only set release when provided (exactOptionalPropertyTypes).
    ...(release !== undefined && release !== '' ? { release } : {}),
    // Sampling is env-tunable; default to a low trace rate to control volume.
    tracesSampleRate: Number(process.env['SENTRY_TRACES_SAMPLE_RATE'] ?? '0.1'),
    // Never let PII leave the process — request bodies/headers are scrubbed.
    sendDefaultPii: false,
  });

  initialized = true;
  logger.log('Sentry initialised.');
}

export function isSentryEnabled(): boolean {
  return initialized;
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
    );
    if (initialized) {
      Sentry.captureException(reason);
    }
  });

  process.on('uncaughtException', (error: Error) => {
    performanceMetrics.recordFailure('unhandled_exception');
    logger.error(`Uncaught exception: ${error.message}`, error.stack);
    if (initialized) {
      Sentry.captureException(error);
    }
  });
}
