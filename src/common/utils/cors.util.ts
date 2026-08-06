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
