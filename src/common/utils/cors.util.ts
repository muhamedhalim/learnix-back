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

  return process.env['NODE_ENV'] === 'production'
    ? ['https://learnix.school']
    : ['https://learnix.school', 'http://localhost:3000'];
}

export function isOriginAllowed(origin: string, allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.includes(normalizeOrigin(origin));
}
