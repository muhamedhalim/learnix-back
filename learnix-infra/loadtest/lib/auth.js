// Login with the real flow: GET /auth/csrf-token (sets the cookie, returns the token), then POST /auth/login with
// X-CSRF-Token. The VU cookie jar then carries access_token / refresh_token / XSRF-TOKEN. Module state is per VU.
import http from 'k6/http';
import { check } from 'k6';

import { API, PASSWORD, clientHeaders, emailFor } from './config.js';
import { phase } from './phase.js';

// Access tokens live at most 15 minutes (src/auth/auth-token.config.ts). Clients refresh well before that.
const REFRESH_AFTER_MS = 10 * 60 * 1000;

let csrf = '';
let current = '';
let loggedInAt = 0;

export function csrfHeader() {
  return csrf === '' ? {} : { 'X-CSRF-Token': csrf };
}

export function fetchCsrf() {
  const res = http.get(`${API}/auth/csrf-token`, {
    headers: clientHeaders(),
    tags: { endpoint: 'auth.csrf', journey: 'auth', name: 'auth.csrf', phase: phase() },
  });
  check(res, { 'auth.csrf 200': (r) => r.status === 200 });
  csrf = res.status === 200 ? res.json('token') : '';
  return csrf;
}

/** Logs the VU in as `<role><index>`; returns false when the login failed so callers can skip the iteration. */
export function login(role, index) {
  const who = `${role}${index}`;
  if (current === who) {
    if (Date.now() - loggedInAt < REFRESH_AFTER_MS) return true;
    // Session is getting old: rotate it like a browser client would; fall through to a full login if that fails.
    const res = refresh();
    if (res.status === 200 || res.status === 201) {
      loggedInAt = Date.now();
      return true;
    }
  }
  http.cookieJar().clear(API);
  fetchCsrf();
  const res = http.post(
    `${API}/auth/login`,
    JSON.stringify({ email: emailFor(role, index), password: PASSWORD }),
    {
      headers: { 'Content-Type': 'application/json', ...clientHeaders(), ...csrfHeader() },
      tags: { endpoint: 'auth.login', journey: 'auth', name: 'auth.login', phase: phase() },
    },
  );
  const ok = check(res, { 'auth.login 200': (r) => r.status === 200 });
  current = ok ? who : '';
  loggedInAt = ok ? Date.now() : 0;
  return ok;
}

/** POST /auth/refresh: rotates the refresh token (bcrypt compare under a row lock; see plan PERF-03). */
export function refresh() {
  fetchCsrf();
  const res = http.post(`${API}/auth/refresh`, null, {
    headers: { ...clientHeaders(), ...csrfHeader() },
    tags: { endpoint: 'auth.refresh', journey: 'auth', name: 'auth.refresh', phase: phase() },
  });
  check(res, { 'auth.refresh 200': (r) => r.status === 200 || r.status === 201 });
  return res;
}
