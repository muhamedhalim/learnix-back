import { isIP } from 'node:net';

export type PublicOriginVariable =
  | 'FRONTEND_URL'
  | 'BACKEND_URL'
  | 'PUBLIC_MEDIA_BASE_URL'
  | 'R2_PUBLIC_BASE_URL'
  | 'BUNNY_CDN_URL'
  | 'CORS_ORIGINS';

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** True for loopback, private, link-local, carrier-grade NAT and metadata ranges. */
export function isNonPublicHostname(hostnameValue: string): boolean {
  const hostname = hostnameValue.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname === 'metadata.google.internal' ||
    hostname === 'instance-data.ec2.internal'
  ) {
    return true;
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const octets = hostname.split('.').map(Number);
    const [a = 0, b = 0] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (ipVersion === 6) {
    return (
      hostname === '::' ||
      hostname === '::1' ||
      hostname.startsWith('fc') ||
      hostname.startsWith('fd') ||
      /^fe[89ab]/u.test(hostname) ||
      hostname.startsWith('::ffff:127.') ||
      hostname.startsWith('::ffff:10.') ||
      hostname.startsWith('::ffff:192.168.')
    );
  }

  // A production public origin must be an externally resolvable DNS name,
  // never an internal container/service label such as `backend` or `api`.
  return !hostname.includes('.');
}

export function parsePublicOrigin(
  value: string,
  variableName: PublicOriginVariable,
  production: boolean,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be an absolute HTTP(S) URL`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${variableName} must use HTTP or HTTPS`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`${variableName} must be an origin without credentials, query, or fragment`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`${variableName} must not contain a path`);
  }
  if (production && (url.protocol !== 'https:' || isNonPublicHostname(normalizedHostname(url)))) {
    throw new Error(`${variableName} must be a public HTTPS origin in production`);
  }

  return url.origin;
}

export function buildAbsoluteUrl(origin: string, path: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/${path.replace(/^\/+/, '')}`;
}

export function getConfiguredPublicOrigin(
  get: (key: string) => string | undefined,
  variableName: PublicOriginVariable,
  developmentFallback: string,
): string {
  const production = get('NODE_ENV') === 'production';
  const configured = get(variableName);
  if ((configured === undefined || configured.trim() === '') && production) {
    throw new Error(`${variableName} is required in production`);
  }
  return parsePublicOrigin(configured ?? developmentFallback, variableName, production);
}

export function validateProductionPublicOrigins(config: Record<string, unknown>): void {
  if (config['NODE_ENV'] !== 'production') return;

  for (const variableName of ['FRONTEND_URL', 'BACKEND_URL'] as const) {
    const value = config[variableName];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${variableName} is required in production`);
    }
    parsePublicOrigin(value, variableName, true);
  }

  for (const variableName of [
    'PUBLIC_MEDIA_BASE_URL',
    'R2_PUBLIC_BASE_URL',
    'BUNNY_CDN_URL',
  ] as const) {
    const value = config[variableName];
    if (typeof value === 'string' && value.trim() !== '') {
      parsePublicOrigin(value, variableName, true);
    }
  }

  const corsValue = config['CORS_ORIGINS'];
  if (typeof corsValue !== 'string' || corsValue.trim() === '') {
    throw new Error('CORS_ORIGINS is required in production');
  }
  if (corsValue.includes('*')) {
    throw new Error('CORS_ORIGINS cannot contain wildcards');
  }
  const corsOrigins = corsValue
    .split(',')
    .map((origin) => parsePublicOrigin(origin.trim(), 'CORS_ORIGINS', true));
  const frontendOrigin = parsePublicOrigin(
    String(config['FRONTEND_URL']),
    'FRONTEND_URL',
    true,
  );
  if (!corsOrigins.includes(frontendOrigin)) {
    throw new Error('CORS_ORIGINS must include FRONTEND_URL');
  }
}
