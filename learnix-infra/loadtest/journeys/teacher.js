import { sleep } from 'k6';

import { COUNTS } from '../lib/config.js';
import { login } from '../lib/auth.js';
import { get } from '../lib/http.js';

export function asTeacher() {
  return login('teacher', ((__VU - 1) % COUNTS.teachers) + 1);
}

export function manage() {
  const j = 'teacher-manage';
  get('/analytics/teacher/dashboard', 'teacher.dashboard', j);
  get('/reports/teacher/summary', 'teacher.report.summary', j);
  get('/teacher/students?limit=20', 'teacher.students.list', j);
  get('/teacher/exams?limit=10', 'teacher.exams.list', j);
  sleep(2 + Math.random() * 4);
}
