// B. Baseline: low, steady arrival rate to get clean per-endpoint latency distributions. Not a capacity test.
//
//   cd learnix-infra/loadtest && node collect/run.mjs scenarios/baseline.js --run-id=baseline-1
//   RATE=2 DURATION=10m ...            student iterations per second (default 1) and hold time
//
// Mix (interim: exam and commerce journeys are not built yet, so the planned 25/35/20/15/5 student split is
// renormalised over the three that exist): browse 40 %, learn 40 %, dashboard 20 %.
// Roles: students 85 %, teachers 10 %, admin 5 % of iteration volume.
import http from 'k6/http';

import { API } from '../lib/config.js';
import { json } from '../lib/http.js';
import { summarize } from '../lib/summary.js';
import { endpointThresholds } from '../lib/thresholds.js';
import { initPhase, toMs } from '../lib/phase.js';
import * as student from '../journeys/student.js';
import * as teacher from '../journeys/teacher.js';
import * as admin from '../journeys/admin.js';

const RATE = Number(__ENV.RATE || 1);
const DURATION = __ENV.DURATION || '10m';
const WARMUP = __ENV.WARMUP || '3m';

// Rates are iterations per MINUTE (k6 needs integer targets; 0.05 per second is not one).
function stream(exec, perMinute, vus) {
  return {
    executor: 'ramping-arrival-rate',
    exec,
    startRate: 0,
    timeUnit: '1m',
    preAllocatedVUs: vus,
    maxVUs: vus * 3,
    // Ramp over WARMUP so first-time logins (about 1 s of bcrypt each) do not land as one burst.
    stages: [
      { duration: WARMUP, target: perMinute },
      { duration: DURATION, target: perMinute },
    ],
  };
}

export const options = {
  // k6 clears each VU's cookie jar between iterations by default; lib/auth.js keeps one session per VU across them.
  noCookiesReset: true,
  scenarios: {
    students: stream('studentIteration', Math.round(RATE * 60), 30),
    teachers: stream('teacherIteration', Math.max(Math.round(RATE * 6), 1), 5),
    admins: stream('adminIteration', Math.max(Math.round(RATE * 3), 1), 2),
  },
  thresholds: {
    ...endpointThresholds(),
    http_req_failed: ['rate<0.005'],
    dropped_iterations: ['count==0'],
  },
  // Keep tagged sub-metric percentiles in the end-of-test summary.
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const res = http.get(`${API}/packages?limit=50`);
  const rows = json(res, 'data') || [];
  if (rows.length === 0) throw new Error('no published packages: run npm run seed:lms-load first');
  return { packageIds: rows.map((p) => p.id), startedAt: Date.now(), warmupMs: toMs(WARMUP) };
}

export function studentIteration(data) {
  initPhase(data);
  if (!student.asStudent()) return;
  const roll = Math.random();
  if (roll < 0.4) student.browse(data);
  else if (roll < 0.8) student.learn();
  else student.dashboard();
}

export function teacherIteration(data) {
  initPhase(data);
  if (!teacher.asTeacher()) return;
  teacher.manage();
}

export function adminIteration(data) {
  initPhase(data);
  if (!admin.asAdmin()) return;
  admin.ops();
}

export function handleSummary(data) {
  return summarize(data, { rate: RATE, duration: DURATION, warmup: WARMUP });
}
