// Target selection with a hard production guard, plus the seed manifest.
//
//   k6 run -e TARGET=http://localhost:3001 scenarios/smoke.js            (default; local stack)
//   k6 run -e TARGET=https://<staging api> -e CONFIRM_TARGET=<host> ...   (staging: needs an approved window)
//
// Run k6 from learnix-infra/loadtest so the relative `.data` and `results` paths resolve.

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
// The deployed staging API hosts. Anything else, including every other learnix.school host, is refused.
const STAGING_HOSTS = ['dz8egx08r1ti9.cloudfront.net', 'api.staging.learnix.school'];

function hostOf(url) {
  const m = /^https?:\/\/([^/:]+)(?::\d+)?(?:\/|$)/.exec(url);
  return m ? m[1].toLowerCase() : '';
}

function resolveTarget() {
  const raw = (__ENV.TARGET || 'http://localhost:3001').replace(/\/$/, '');
  const host = hostOf(raw);
  if (host === '') throw new Error(`TARGET is not a valid http(s) URL: ${raw}`);
  if (LOCAL_HOSTS.indexOf(host) !== -1) return raw;
  if (STAGING_HOSTS.indexOf(host) !== -1) {
    if (__ENV.CONFIRM_TARGET !== host) {
      throw new Error(
        `Refusing ${host}: staging runs need -e CONFIRM_TARGET=${host} and an approved test window.`,
      );
    }
    return raw;
  }
  if (host === 'learnix.school' || host.endsWith('.learnix.school')) {
    throw new Error(
      `Refusing ${host}: production hosts are blocked. Load tests never run against production.`,
    );
  }
  throw new Error(`Refusing ${host}: not a known local or staging host.`);
}

export const BASE_URL = resolveTarget();
export const API = `${BASE_URL}/api/v1`;
export const RUN_ID = __ENV.RUN_ID || 'adhoc';

const manifest = JSON.parse(open('../.data/seed-manifest.json'));
export const PASSWORD = manifest.password;
export const EMAIL_DOMAIN = manifest.emailDomain;
export const COUNTS = {
  students: manifest.accounts.students.count,
  teachers: manifest.accounts.teachers.count,
};

// Client addressing. The api throttles per IP (300 req/min globally, 5 logins per 5 min, 5 refreshes per min in
// production), and a single k6 host would hit that within seconds. On a LOCAL target each VU therefore presents its
// own address through X-Forwarded-For (the api trusts one proxy hop, so Express takes the last entry), which models
// students on separate connections without relaxing any limit. CLIENT_IPS=shared puts every VU behind ONE address
// on purpose: the school-NAT scenario that reproduces the real 429 behaviour. Never sent to non-local targets.
export const IS_LOCAL = LOCAL_HOSTS.indexOf(hostOf(BASE_URL)) !== -1;
const CLIENT_IPS = __ENV.CLIENT_IPS || 'per-vu';
const SHARED_IP = __ENV.SHARED_IP || '10.200.0.1';
const octet = () => 1 + Math.floor(Math.random() * 254);
const VU_IP = `10.${octet()}.${octet()}.${octet()}`;

export function clientHeaders() {
  if (!IS_LOCAL || CLIENT_IPS === 'off') return {};
  return { 'X-Forwarded-For': CLIENT_IPS === 'shared' ? SHARED_IP : VU_IP };
}

export function emailFor(role, index) {
  return `${role}${index}@${EMAIL_DOMAIN}`;
}
