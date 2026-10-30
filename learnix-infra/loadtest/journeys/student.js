// Student journeys, built only from routes verified against the seeded stack
// (see docs/performance/load-test-results.md).
import { sleep } from 'k6';

import { COUNTS } from '../lib/config.js';
import { login } from '../lib/auth.js';
import { get, json, send } from '../lib/http.js';

/** Each VU keeps one stable student, so per-user caches and sessions behave like a returning user. */
export function studentIndex() {
  return ((__VU - 1) % COUNTS.students) + 1;
}

export function asStudent() {
  return login('student', studentIndex());
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Public catalogue browsing: the traffic the frontend sends straight to origin (CloudFront caching is disabled).
export function browse(data) {
  const j = 'student-browse';
  get('/packages?limit=12', 'packages.list', j);
  sleep(1 + Math.random() * 2);
  get('/subjects?limit=20', 'subjects.list', j);
  get('/teachers?limit=10', 'teachers.list', j);
  sleep(1 + Math.random() * 2);
  get(`/packages/${pick(data.packageIds)}`, 'packages.detail', j);
  if (Math.random() < 0.3) get('/search?q=Load', 'search.all', j);
}

let ownedLessons = null;

// Watching a lesson: enter, a few progress ticks, record watched time, exit.
// Writes lesson_sessions and lesson_progress.
export function learn() {
  const j = 'student-learn';
  if (ownedLessons === null) {
    const res = get('/student/lessons/my/progress', 'student.progress.list', j);
    const rows = json(res, 'data') || [];
    ownedLessons = rows.map((r) => r.lessonId);
  }
  if (ownedLessons.length === 0) return;
  const lessonId = pick(ownedLessons);
  const entered = send('POST', `/lessons/${lessonId}/enter`, {}, 'lesson.enter', j, 201);
  const sessionId = json(entered, 'data.id');
  if (sessionId === undefined) return;
  for (let tick = 1; tick <= 3; tick++) {
    sleep(2 + Math.random() * 3);
    send(
      'PATCH',
      `/lessons/sessions/${sessionId}/progress`,
      { video_progress_percent: tick * 20, duration_seconds: tick * 30 },
      'lesson.session.progress',
      j,
    );
  }
  send(
    'POST',
    `/student/lessons/${lessonId}/progress`,
    { watchedDuration: 120 + Math.floor(Math.random() * 600) },
    'lesson.progress.write',
    j,
    201,
  );
  send(
    'POST',
    `/lessons/${lessonId}/exit`,
    { video_progress_percent: 80, duration_seconds: 120 },
    'lesson.exit',
    j,
    201,
  );
}

// The student landing page fan-out plus the notification bell.
export function dashboard() {
  const j = 'student-dashboard';
  get('/analytics/student/dashboard', 'student.dashboard', j);
  get('/notifications/unread/count', 'notifications.unread', j);
  get('/notifications?limit=10', 'notifications.list', j);
  get('/reports/student/progress', 'student.report.progress', j);
  get('/student/exams?limit=10', 'student.exams.list', j);
  sleep(1 + Math.random() * 3);
}
