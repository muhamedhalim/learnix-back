import * as Sentry from '@sentry/node';

/**
 * Initialize Sentry for error tracking and performance monitoring
 * Only initializes if SENTRY_DSN is provided
 */
export function initializeSentry(): void {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    console.log('Sentry DSN not configured - error tracking disabled');
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',

    // Performance monitoring
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

    // Release tracking
    release: process.env.npm_package_version || '1.0.0',

    // Filter sensitive data
    beforeSend(event) {
      // Remove sensitive headers
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['cookie'];
        delete event.request.headers['x-csrf-token'];
      }

      // Remove sensitive data from request body
      if (event.request?.data) {
        const sensitiveFields = ['password', 'token', 'secret', 'apiKey'];
        for (const field of sensitiveFields) {
          if (
            typeof event.request.data === 'object' &&
            field in event.request.data
          ) {
            (event.request.data as Record<string, unknown>)[field] =
              '[REDACTED]';
          }
        }
      }

      return event;
    },

    // Ignore common non-error scenarios
    ignoreErrors: [
      'NotFoundException',
      'UnauthorizedException',
      'ForbiddenException',
      'BadRequestException',
    ],

    // Integration configuration
    integrations: [Sentry.httpIntegration()],
  });

  console.log('Sentry initialized for error tracking');
}

/**
 * Capture an exception with additional context
 */
export function captureException(
  error: Error,
  context?: Record<string, unknown>,
): void {
  if (context) {
    Sentry.setContext('additional', context);
  }
  Sentry.captureException(error);
}

/**
 * Capture a message with severity level
 */
export function captureMessage(
  message: string,
  level: 'info' | 'warning' | 'error' = 'info',
): void {
  Sentry.captureMessage(message, level);
}

/**
 * Set user context for error tracking
 */
export function setUser(user: {
  id: number;
  email?: string;
  role?: string;
}): void {
  Sentry.setUser({
    id: String(user.id),
    email: user.email,
    role: user.role,
  });
}

/**
 * Clear user context (on logout)
 */
export function clearUser(): void {
  Sentry.setUser(null);
}

export { Sentry };
