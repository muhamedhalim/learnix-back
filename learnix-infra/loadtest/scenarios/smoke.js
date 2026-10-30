// A. Smoke: every journey once, plus the auth flow. Gate for every heavier scenario: any failed check fails the run.
//   cd learnix-infra/loadtest && k6 run -e RUN_ID=smoke-1 scenarios/smoke.js
import http from 'k6/http';

import { API } from '../lib/config.js';
import { refresh } from '../lib/auth.js';
import { get, json } from '../lib/http.js';
import { summarize } from '../lib/summary.js';
import * as student from '../journeys/student.js';
import * as teacher from '../journeys/teacher.js';
import * as admin from '../journeys/admin.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export function setup() {
  const res = http.get(`${API}/packages?limit=50`);
  const rows = json(res, 'data') || [];
  if (rows.length === 0) throw new Error('no published packages: run npm run seed:lms-load first');
  return { packageIds: rows.map((p) => p.id) };
}

export default function (data) {
  student.asStudent();
  student.browse(data);
  student.dashboard();
  student.learn();
  refresh(); // rotates the refresh token; the next call proves the rotated session still authenticates
  get('/notifications/unread/count', 'notifications.unread.afterRefresh', 'auth');

  teacher.asTeacher();
  teacher.manage();

  admin.asAdmin();
  admin.ops();
}

export function handleSummary(data) {
  return summarize(data);
}
