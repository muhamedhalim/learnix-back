#!/usr/bin/env node
// Black-box acceptance checks for a deployed API host (Phase 3/4 exit). Run from an address the WAF allows:
//   node scripts/staging-acceptance.mjs https://<api host> --frontend https://<vercel frontend origin>
//        [--video-asset <id>] [--pin <cloudfront domain>]
// The frontend is hosted on Vercel; AWS serves only the API host, so every request here goes to the API and the
// cross-origin contract with the frontend (credentialed CORS, exact origins) is checked explicitly.
// --pin tests the CloudFront distribution directly while the API host's DNS still points elsewhere: the TCP
// connection goes to the distribution, the Host header and TLS name stay the API host's.
// Read-only: only GET/HEAD/OPTIONS requests. Exits 1 if any check fails.
const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!/^https:\/\//.test(base)) {
  console.error('usage: staging-acceptance.mjs https://<api host> --frontend https://<frontend origin> [--video-asset <id>] [--pin <cf domain>]');
  process.exit(2);
}
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const videoAsset = arg('--video-asset');
const pin = arg('--pin');
const frontend = (arg('--frontend') ?? '').replace(/\/$/, '');
if (!/^https:\/\/[a-z0-9.-]+$/i.test(frontend)) {
  console.error('--frontend https://<exact frontend origin> is required (the origin the browser calls the API from)');
  process.exit(2);
}

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
  }
}
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';

async function pinnedRequest(path, method, headers) {
  const { address } = await dnsLookup(pin);
  const host = new URL(base).hostname;
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: address, servername: host, path, method, headers: { Host: host, ...headers }, timeout: 15000 },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: { get: (k) => res.headers[k.toLowerCase()] ?? null } }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
const request = (path, method = 'GET', headers = {}) =>
  pin ? pinnedRequest(path, method, headers) : fetch(base + path, { method, headers, redirect: 'manual' });
const get = (path) => request(path);
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
const preflight = (origin, path = '/api/v1/auth/login') =>
  request(path, 'OPTIONS', {
    Origin: origin,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-csrf-token',
  });

await check('api liveness /api/v1/health', async () => {
  const r = await get('/api/v1/health');
  expect(r.status === 200, `status ${r.status}`);
});
await check('api readiness (database + Valkey reachable over TLS)', async () => {
  const r = await get('/api/v1/health/readiness');
  expect(r.status === 200, `status ${r.status}`);
});
await check('http is redirected to https', async () => {
  const r = await fetch(base.replace('https://', 'http://') + '/api/v1/health', { redirect: 'manual' });
  expect([301, 302, 308].includes(r.status), `status ${r.status}`);
});
await check('security headers present', async () => {
  const r = await get('/api/v1/health');
  expect(r.headers.get('strict-transport-security'), 'missing HSTS');
  expect(r.headers.get('x-content-type-options') === 'nosniff', 'missing nosniff');
});
await check('API responses are not cached by the edge', async () => {
  const r = await get('/api/v1/health');
  expect(!/Hit from cloudfront/i.test(r.headers.get('x-cache') ?? ''), `x-cache=${r.headers.get('x-cache')}`);
});
await check('unauthenticated API call is rejected, not 5xx', async () => {
  const r = await get('/api/v1/users/me');
  expect([401, 403].includes(r.status), `status ${r.status}`);
});
await check('metrics endpoint is not publicly readable', async () => {
  const r = await get('/metrics');
  expect(r.status !== 200, 'metrics returned 200 without a token');
});

// --- Cross-origin contract with the Vercel frontend ---------------------------------------------------
await check('preflight from the frontend origin is allowed with credentials', async () => {
  const r = await preflight(frontend);
  expect([200, 204].includes(r.status), `status ${r.status}`);
  expect(r.headers.get('access-control-allow-origin') === frontend, `allow-origin=${r.headers.get('access-control-allow-origin')}`);
  expect(r.headers.get('access-control-allow-credentials') === 'true', 'credentials not allowed');
  expect(/x-csrf-token/i.test(r.headers.get('access-control-allow-headers') ?? ''), 'X-CSRF-Token not allowed');
});
await check('preflight from a foreign origin is refused', async () => {
  const r = await preflight('https://evil.example');
  expect(!r.headers.get('access-control-allow-origin'), `allow-origin=${r.headers.get('access-control-allow-origin')}`);
});
await check('a Vercel preview URL is not trusted by this API', async () => {
  const r = await preflight('https://learnix-git-feature-someteam.vercel.app');
  expect(!r.headers.get('access-control-allow-origin'), `allow-origin=${r.headers.get('access-control-allow-origin')}`);
});
await check('video segment without signed cookies is refused', async () => {
  const id = videoAsset ?? '00000000-0000-0000-0000-000000000000';
  const r = await get(`/video/${id}/hls/index.m3u8`);
  expect(r.status === 403, `status ${r.status} (expected 403)`);
});

// --- The Vercel-hosted frontend itself (reachability only; Vercel is not part of the AWS stack) -------
await check('frontend answers (Vercel)', async () => {
  const r = await fetch(`${frontend}/ar`, { redirect: 'manual' });
  expect([200, 307, 308].includes(r.status), `status ${r.status}`);
});

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? `  -> ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
