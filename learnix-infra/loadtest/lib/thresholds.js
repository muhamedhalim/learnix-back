// PROPOSED p95 limits per endpoint (ms), for review. Only FR-331 (marketplace catalogue, not used here) is an
// established requirement; everything else is a starting proposal from the performance plan. A threshold miss is a
// finding, not a bug in the test. Endpoint names are the `endpoint` tag set by lib/http.js.
export const LIMITS_MS = {
  // Public reads (FR-331-style bound)
  'packages.list': 500,
  'subjects.list': 500,
  'teachers.list': 500,
  'packages.detail': 400,
  'search.all': 500,
  // Per-student reads
  'student.dashboard': 500,
  'student.report.progress': 500,
  'student.exams.list': 500,
  'student.progress.list': 500,
  'notifications.unread': 300,
  'notifications.list': 500,
  // Watch lifecycle (writes)
  'lesson.enter': 500,
  'lesson.session.progress': 300,
  'lesson.progress.write': 500,
  'lesson.exit': 500,
  // Teacher
  'teacher.dashboard': 1000,
  'teacher.report.summary': 1000,
  'teacher.students.list': 500,
  'teacher.exams.list': 500,
  // Admin (cold compute allowed to be slower)
  'admin.dashboard': 2000,
  'admin.report.platform': 2000,
  'admin.students.list': 800,
  'admin.payments.list': 800,
  // Auth: bcrypt-bound
  'auth.login': 1500,
  'auth.refresh': 1500,
  'auth.csrf': 300,
};

export function endpointThresholds() {
  const t = {};
  for (const [endpoint, ms] of Object.entries(LIMITS_MS)) {
    // abortOnFail stays off: a baseline must finish so every miss is recorded.
    t[`http_req_duration{endpoint:${endpoint},phase:steady}`] = [`p(95)<${ms}`];
  }
  return t;
}
