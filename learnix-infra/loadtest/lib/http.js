// Tagged request helpers. Every request carries `endpoint` (a stable name, never the raw URL, so path ids do not
// explode metric cardinality) and `journey`, and one check named after the endpoint and expected status.
import http from 'k6/http';
import { check } from 'k6';

import { API, clientHeaders } from './config.js';
import { csrfHeader } from './auth.js';
import { phase } from './phase.js';

function verify(res, endpoint, expected) {
  const ok = check(res, { [`${endpoint} ${expected}`]: (r) => r.status === expected });
  if (!ok && __ENV.DEBUG) {
    console.warn(
      `${endpoint} -> ${res.status} request=${res.headers['X-Request-Id']} body=${String(res.body).slice(0, 160)}`,
    );
  }
  return res;
}

export function get(path, endpoint, journey, expected = 200) {
  const res = http.get(`${API}${path}`, {
    headers: clientHeaders(),
    tags: { endpoint, journey, name: endpoint, phase: phase() },
  });
  return verify(res, endpoint, expected);
}

export function send(method, path, body, endpoint, journey, expected = 200) {
  const res = http.request(method, `${API}${path}`, body === null ? null : JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...clientHeaders(), ...csrfHeader() },
    tags: { endpoint, journey, name: endpoint, phase: phase() },
  });
  return verify(res, endpoint, expected);
}

export function json(res, selector) {
  try {
    return res.json(selector);
  } catch (e) {
    return undefined;
  }
}
