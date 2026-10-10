/**
 * Web Push subscriptions (the browser's `PushSubscription.toJSON()`), stored in the existing
 * `push_devices.token` column as a JSON string.
 *
 * SECURITY: the server POSTs to `subscription.endpoint`, a URL supplied by the client. Without
 * validation that is a server-side request forgery primitive (internal addresses, metadata
 * endpoints, arbitrary hosts). Endpoints are therefore restricted to the push services the major
 * browsers actually use, over HTTPS on the default port.
 */
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Hostname suffixes of real browser push services. */
const ALLOWED_PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com', // Chrome, Edge, Brave, Opera, Samsung Internet
  'android.googleapis.com', // legacy GCM-era Chrome endpoints
  'push.services.mozilla.com', // Firefox desktop
  'push.mozilla.org', // Firefox (newer)
  'push.apple.com', // Safari / iOS (web.push.apple.com, *.push.apple.com)
  'notify.windows.com', // legacy Edge / WNS
] as const;

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  if (url.port !== '' && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  // An IP literal can never be a legitimate push service host.
  if (/^[\d.]+$/.test(host) || host.includes(':')) return false;
  return ALLOWED_PUSH_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Parses and validates a stored/submitted token. Returns null for anything that is not a safe subscription. */
export function parseWebPushToken(token: string): WebPushSubscription | null {
  let value: unknown;
  try {
    value = JSON.parse(token);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const { endpoint, keys } = record;
  if (typeof endpoint !== 'string' || !isAllowedPushEndpoint(endpoint)) return null;
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (
    typeof p256dh !== 'string' ||
    typeof auth !== 'string' ||
    !BASE64URL.test(p256dh) ||
    !BASE64URL.test(auth) ||
    p256dh.length < 20 ||
    p256dh.length > 200 ||
    auth.length < 8 ||
    auth.length > 64
  ) {
    return null;
  }
  return { endpoint, keys: { p256dh, auth } };
}

/** A log-safe label for a subscription token: the push service host only, never the endpoint path. */
export function describeWebPushToken(token: string): string {
  const parsed = parseWebPushToken(token);
  return parsed === null ? 'invalid-subscription' : new URL(parsed.endpoint).hostname;
}
