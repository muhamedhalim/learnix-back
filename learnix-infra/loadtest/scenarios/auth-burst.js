// K. Auth burst: how much do logins (bcrypt) slow down unrelated traffic on a 0.5 vCPU api? (PERF-03 evidence)
//
//   cd learnix-infra/loadtest && node collect/run.mjs scenarios/auth-burst.js --run-id=auth-burst-1
//   BURST_RATES=15,30,45,60 STAGE=60 QUIET=45 MODE=login|refresh ...
//
// Two streams run at once:
//   victim   constant 5 req/s of cheap public GETs (/packages, /subjects). They need no login, so any slowdown in
//            them while logins run is event-loop or CPU starvation, not their own cost.
//   logins   ramping arrival rate (per MINUTE: k6 needs integer targets) of full login flows (csrf-token + POST /auth/login), each as a different student with
//            a fresh client address, so the per-IP throttle is not what is being measured. MODE=refresh adds a
//            POST /auth/refresh right after each login.
// Stages (tag `stage`): quiet-before (control) -> burst-<rate>/s for each BURST_RATES -> quiet-after (recovery).
// Compare the victim's per-stage latency. No thresholds fail the run; the point is the table.
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

import { API, COUNTS, IS_LOCAL, PASSWORD, emailFor } from '../lib/config.js';

const RATES = (__ENV.BURST_RATES || '15,30,45,60').split(',').map(Number); // logins per minute
const STAGE_S = Number(__ENV.STAGE || 60);
const QUIET_S = Number(__ENV.QUIET || 45);
const MODE = __ENV.MODE || 'login';
const VICTIM_RATE = Number(__ENV.VICTIM_RATE || 5);

if (!IS_LOCAL) throw new Error('auth-burst is local-stack only: it deliberately saturates the api CPU.');

const RAMP_S = 5;
const stageNames = ['quiet-before', ...RATES.map((r) => `burst-${r}/min`), 'quiet-after'];

function loginStages() {
  const s = [{ duration: `${QUIET_S}s`, target: 0 }];
  RATES.forEach((r) => {
    s.push({ duration: `${RAMP_S}s`, target: r }, { duration: `${STAGE_S - RAMP_S}s`, target: r });
  });
  s.push({ duration: `${QUIET_S}s`, target: 0 });
  return s;
}

export const options = {
  scenarios: {
    victim: {
      executor: 'constant-arrival-rate',
      exec: 'victim',
      rate: VICTIM_RATE,
      timeUnit: '1s',
      duration: `${QUIET_S * 2 + STAGE_S * RATES.length}s`,
      preAllocatedVUs: 10,
      maxVUs: 40,
    },
    logins: {
      executor: 'ramping-arrival-rate',
      exec: 'loginFlow',
      startRate: 0,
      timeUnit: '1m',
      preAllocatedVUs: 20,
      maxVUs: 120,
      stages: loginStages(),
    },
  },
  // Dummy thresholds only force k6 to keep per-stage sub-metrics for the summary table.
  thresholds: Object.fromEntries(
    stageNames.flatMap((st) => [
      [`http_req_duration{endpoint:victim,stage:${st}}`, ['max>=0']],
      [`http_req_duration{endpoint:auth.login,stage:${st}}`, ['max>=0']],
      [`http_req_duration{endpoint:auth.refresh,stage:${st}}`, ['max>=0']],
      [`http_reqs{endpoint:auth.login,stage:${st}}`, ['count>=0']],
      [`http_reqs{endpoint:victim,stage:${st}}`, ['count>=0']],
    ]),
  ),
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  return { startedAt: Date.now() };
}

function stageAt(data) {
  const t = (Date.now() - data.startedAt) / 1000;
  if (t < QUIET_S) return stageNames[0];
  const i = Math.floor((t - QUIET_S) / STAGE_S);
  return i < RATES.length ? stageNames[1 + i] : stageNames[stageNames.length - 1];
}

const octet = () => 1 + Math.floor(Math.random() * 254);
const freshIp = () => ({ 'X-Forwarded-For': `10.${octet()}.${octet()}.${octet()}` });

export function victim(data) {
  const stage = stageAt(data);
  const path = Math.random() < 0.5 ? '/packages?limit=12' : '/subjects?limit=20';
  const res = http.get(`${API}${path}`, {
    headers: freshIp(),
    tags: { endpoint: 'victim', name: 'victim', stage },
  });
  check(res, { 'victim 200': (r) => r.status === 200 });
}

export function loginFlow(data) {
  const stage = stageAt(data);
  const headers = { 'Content-Type': 'application/json', ...freshIp() };
  http.cookieJar().clear(API);
  const csrfRes = http.get(`${API}/auth/csrf-token`, {
    headers,
    tags: { endpoint: 'auth.csrf', name: 'auth.csrf', stage },
  });
  if (csrfRes.status !== 200) return;
  const token = csrfRes.json('token');
  const index = (exec.scenario.iterationInTest % COUNTS.students) + 1;
  const login = http.post(
    `${API}/auth/login`,
    JSON.stringify({ email: emailFor('student', index), password: PASSWORD }),
    { headers: { ...headers, 'X-CSRF-Token': token }, tags: { endpoint: 'auth.login', name: 'auth.login', stage } },
  );
  const ok = check(login, { 'auth.login 200': (r) => r.status === 200 });
  if (ok && MODE === 'refresh') {
    const refresh = http.post(`${API}/auth/refresh`, null, {
      headers: { ...headers, 'X-CSRF-Token': token },
      tags: { endpoint: 'auth.refresh', name: 'auth.refresh', stage },
    });
    check(refresh, { 'auth.refresh 2xx': (r) => r.status === 200 || r.status === 201 });
  }
}

const f = (v) => (v === undefined ? '-' : v.toFixed(0));

export function handleSummary(data) {
  const m = data.metrics;
  const rows = [];
  for (const endpoint of ['victim', 'auth.login', 'auth.refresh']) {
    for (const st of stageNames) {
      const k = `http_req_duration{endpoint:${endpoint},stage:${st}}`;
      if (!m[k] || !m[k].values || m[k].values.count === 0) continue;
      const v = m[k].values;
      const n = m[`http_reqs{endpoint:${endpoint},stage:${st}}`];
      rows.push(
        `${endpoint.padEnd(13)}${st.padEnd(15)}${String(n ? n.values.count : '-').padStart(6)}${f(v.med).padStart(8)}${f(v['p(90)']).padStart(8)}${f(v['p(95)']).padStart(8)}${f(v['p(99)']).padStart(8)}${f(v.max).padStart(8)}`,
      );
    }
  }
  const d = m.dropped_iterations ? m.dropped_iterations.values.count : 0;
  const text = [
    `auth-burst mode=${MODE} rates=${RATES.join(',')}/min stage=${STAGE_S}s quiet=${QUIET_S}s victim=${VICTIM_RATE}/s`,
    `dropped_iterations ${d}  (login arrivals that k6 could not start: the api fell behind)`,
    'endpoint     stage            count     p50     p90     p95     p99     max   (ms)',
    ...rows,
    '',
  ].join('\n');
  const runId = __ENV.RUN_ID || 'auth-burst';
  return { stdout: text, [`results/${runId}/summary.json`]: JSON.stringify({ rows, data }, null, 2) };
}
