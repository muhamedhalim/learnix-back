import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/** Exact credentialed-CORS allowlist. Production never trusts localhost by default. */
export function getAllowedOrigins(): string[] {
  const configured = process.env['CORS_ORIGINS'];
  if (configured) {
    return [
      ...new Set(
        configured
          .split(',')
          .map((origin) => normalizeOrigin(origin.trim()))
          .filter(Boolean),
      ),
    ];
  }

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('CORS_ORIGINS is required in production');
  }
  // Finding A-17: this used to include the production origin
  // (https://learnix.school), so a non-production boot that forgot to set
  // CORS_ORIGINS would silently trust the real production frontend. A
  // development/staging fallback must never name a production resource — see
  // docs/NODE_ENV_AUDIT.md #10 and environment-isolation.guard.ts.
  return ['http://localhost:3000'];
}

export function isOriginAllowed(origin: string, allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.includes(normalizeOrigin(origin));
}

/**
 * The credentialed CORS contract between the Vercel-hosted frontend and this API (a separate origin):
 * only exact allowlisted origins receive `Access-Control-Allow-Origin` (echoed, never `*`) with credentials,
 * so the auth cookies and the CSRF header can travel; every other browser origin gets no CORS headers and is
 * blocked by the browser. Requests without an Origin header (webhooks, health checks, server-to-server) are
 * not CORS requests and pass through to their own authentication.
 */
export function buildCorsOptions(
  allowedOrigins: readonly string[],
  onBlocked?: (origin: string) => void,
): CorsOptions {
  return {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (isOriginAllowed(origin, allowedOrigins)) return callback(null, true);
      onBlocked?.(origin);
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  };
}
