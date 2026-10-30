import { sleep } from 'k6';

import { login } from '../lib/auth.js';
import { get } from '../lib/http.js';

export function asAdmin() {
  return login('admin', 1);
}

export function ops() {
  const j = 'admin-ops';
  get('/analytics/admin/dashboard', 'admin.dashboard', j);
  get('/reports/admin/platform', 'admin.report.platform', j);
  get('/admin/students?limit=20', 'admin.students.list', j);
  get('/admin/payments?limit=20', 'admin.payments.list', j);
  sleep(2 + Math.random() * 4);
}
