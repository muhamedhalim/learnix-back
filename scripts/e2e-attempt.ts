/**
 * End-to-end verification of the Attempt Engine + BullMQ jobs against the
 * RUNNING backend. Covers: author→publish, start, autosave, resume, submit,
 * auto-grading, essay pending→manual grade, result, AI-suggestion job, analytics
 * job, delayed auto-submit job, and the failure scenarios (idempotent submit,
 * no-access, concurrent start).
 */
import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { Queue } from 'bullmq';
import { Client } from 'pg';

const BASE = 'http://localhost:3001/api/v1';
const PASSWORD = 'Passw0rd!';
const redisConn = { host: process.env['REDIS_HOST'] ?? 'localhost', port: Number(process.env['REDIS_PORT'] ?? 6379) };

let csrfToken = '';
let csrfCookie = '';
let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string): void {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (cond) pass++; else fail++;
  if (!cond) process.exitCode = 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function primeCsrf(): Promise<void> {
  const res = await fetch(`${BASE}/auth/csrf-token`);
  const setCookies = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const xsrf = setCookies.find((c) => c.startsWith('XSRF-TOKEN='));
  if (xsrf) csrfCookie = xsrf.split(';')[0];
  const body = (await res.json()) as { data?: { token?: string }; token?: string };
  csrfToken = body.data?.token ?? body.token ?? '';
}

async function api(method: string, path: string, token?: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (method !== 'GET') { headers['x-csrf-token'] = csrfToken; headers['Cookie'] = csrfCookie; }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function seedUser(client: Client, email: string, role: string, username: string): Promise<string> {
  const hash = await bcrypt.hash(PASSWORD, 12);
  const res = await client.query(
    `INSERT INTO users (username, name, email, phone, password_hash, role, status, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,'approved',true)
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, status='approved', is_active=true, role=EXCLUDED.role
     RETURNING id`,
    [username, `E2E ${role}`, email, `0100${Math.floor(Math.random() * 9000000 + 1000000)}`, hash, role],
  );
  return res.rows[0].id as string;
}

async function login(email: string): Promise<string> {
  const { status, body } = await api('POST', '/auth/login', undefined, { email, password: PASSWORD });
  const token = body?.data?.token ?? body?.token;
  if (status >= 400 || !token) throw new Error(`login failed (${status}): ${JSON.stringify(body)}`);
  return token as string;
}

const responseFor: Record<string, unknown> = {
  single_choice: { optionId: 'b' },
  multiple_select: { optionIds: ['a', 'c'] },
  true_false: { value: true },
  fill_blank: { blanks: [{ id: '1', value: 'Cairo' }] },
  numeric: { value: 42 },
  essay: { text: 'An object at rest stays at rest unless acted upon by an external force. Newton first law inertia.' },
};

function questionPayloads(subjectId: string) {
  return [
    { type: 'single_choice', subject_id: subjectId, default_marks: 5, content: { prompt: { en: '2+2?' }, options: [{ id: 'a', text: { en: '3' } }, { id: 'b', text: { en: '4' } }] }, answer_key: { correctOptionId: 'b' } },
    { type: 'multiple_select', subject_id: subjectId, default_marks: 6, content: { prompt: { en: 'Even?' }, options: [{ id: 'a', text: { en: '2' } }, { id: 'b', text: { en: '3' } }, { id: 'c', text: { en: '4' } }, { id: 'd', text: { en: '5' } }] }, answer_key: { correctOptionIds: ['a', 'c'] } },
    { type: 'true_false', subject_id: subjectId, default_marks: 2, content: { prompt: { en: 'Earth round?' } }, answer_key: { value: true } },
    { type: 'fill_blank', subject_id: subjectId, default_marks: 4, content: { prompt: { en: 'Capital {{1}}' }, blanks: [{ id: '1' }] }, answer_key: { blanks: [{ id: '1', accepted: ['Cairo'] }] } },
    { type: 'numeric', subject_id: subjectId, default_marks: 3, content: { prompt: { en: '6x7?' } }, answer_key: { value: 42, tolerance: 0 } },
    { type: 'essay', subject_id: subjectId, default_marks: 10, content: { prompt: { en: "Newton's first law?" } }, answer_key: { modelAnswer: { en: 'An object at rest stays at rest unless acted upon by an external force inertia.' } } },
  ];
}

async function buildExam(token: string, subjectId: string, durationSec: number, types: string[], lessonId?: string): Promise<string> {
  const examRes = await api('POST', '/teacher/exams', token, {
    title: 'E2E Attempt Exam', title_ar: 'ا', subject_id: subjectId, passing_marks: 1,
    config: { duration_seconds: durationSec, grace_seconds: 1, review_policy: 'after_graded', ...(lessonId ? {} : {}) },
    ...(lessonId ? { lesson_id: lessonId } : {}),
  });
  const examId = examRes.body.id as string;
  const sectionRes = await api('POST', `/teacher/exams/${examId}/sections`, token, { title: 'S1' });
  const sectionId = sectionRes.body.id as string;
  for (const q of questionPayloads(subjectId).filter((x) => types.includes(x.type))) {
    const qRes = await api('POST', '/teacher/questions', token, q);
    await api('POST', `/teacher/exams/${examId}/questions`, token, { question_id: qRes.body.id, section_id: sectionId });
  }
  await api('POST', `/teacher/exams/${examId}/publish`, token);
  return examId;
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env['DATABASE_URL'] });
  await client.connect();
  const subjectId = (await client.query(`SELECT id FROM subjects WHERE deleted_at IS NULL LIMIT 1`)).rows[0].id as string;
  const lesson = await client.query(`SELECT id FROM lessons WHERE deleted_at IS NULL LIMIT 1`);
  const lessonId = lesson.rows[0]?.id as string | undefined;

  const teacherId = await seedUser(client, 'teacher.e2e@test.local', 'teacher', 'teacher_e2e');
  const studentId = await seedUser(client, 'student.e2e@test.local', 'student', 'student_e2e');
  // Clean prior test exams/questions for a deterministic run.
  await client.query(`DELETE FROM exams WHERE teacher_id=$1`, [teacherId]);
  await client.query(`DELETE FROM questions WHERE teacher_id=$1`, [teacherId]);

  await primeCsrf();
  const teacherToken = await login('teacher.e2e@test.local');
  const studentToken = await login('student.e2e@test.local');
  ok(!!teacherToken && !!studentToken, 'teacher + student logged in');

  const allTypes = ['single_choice', 'multiple_select', 'true_false', 'fill_blank', 'numeric', 'essay'];
  const examId = await buildExam(teacherToken, subjectId, 120, allTypes);
  ok(!!examId, 'exam authored + published');

  // ---- START ----
  const startRes = await api('POST', `/student/exams/${examId}/start`, studentToken);
  ok(startRes.status === 201 && startRes.body?.questions?.length === 6, `start attempt → ${startRes.status}, 6 questions rendered`);
  const attemptId = startRes.body.attempt_id as string;
  const q = startRes.body.questions as { exam_question_id: string; type: string; content: any }[];
  ok(q.every((x) => x.content && x.content.answer_key === undefined && x.content.correctOptionId === undefined), 'rendered content carries NO answer key');
  ok(startRes.body.remaining_seconds > 0 && startRes.body.remaining_seconds <= 120, `server-authoritative timer present (${startRes.body.remaining_seconds}s)`);

  const byType = new Map(q.map((x) => [x.type, x.exam_question_id]));

  // ---- AUTOSAVE (subset) ----
  const firstBatch = ['single_choice', 'true_false'].map((t) => ({ exam_question_id: byType.get(t)!, response: responseFor[t], time_spent_ms: 1500 }));
  const saveRes = await api('PATCH', `/student/exams/attempts/${attemptId}/answers`, studentToken, { answers: firstBatch });
  ok(saveRes.status === 200 && saveRes.body?.saved === 2, `autosave 2 answers → saved=${saveRes.body?.saved}`);
  const savedDb = await client.query(`SELECT count(*)::int c FROM exam_attempt_answers WHERE attempt_id=$1 AND response IS NOT NULL`, [attemptId]);
  ok(savedDb.rows[0].c === 2, 'DB: 2 answers persisted with response');

  // ---- RESUME (simulate refresh/disconnect) ----
  const resume = await api('GET', `/student/exams/attempts/${attemptId}`, studentToken);
  const resumedAnswered = (resume.body.questions as any[]).filter((x) => x.saved_response != null).length;
  ok(resume.status === 200 && resumedAnswered === 2, `resume restores saved answers (${resumedAnswered}/2)`);

  // ---- SUBMIT (flush remaining answers) ----
  const rest = ['multiple_select', 'fill_blank', 'numeric', 'essay'].map((t) => ({ exam_question_id: byType.get(t)!, response: responseFor[t] }));
  const submitRes = await api('POST', `/student/exams/attempts/${attemptId}/submit`, studentToken, { answers: rest, idempotency_key: 'idem-e2e-1' });
  ok(submitRes.status === 201, `submit → ${submitRes.status}`);
  ok(submitRes.body?.score_auto === 20, `objective auto-graded: score_auto=${submitRes.body?.score_auto} (expected 20)`);
  ok(submitRes.body?.state === 'grading' && submitRes.body?.pending_manual === 1, `essay pending → state=${submitRes.body?.state}, pending_manual=${submitRes.body?.pending_manual}`);

  // ---- IDEMPOTENT DUPLICATE SUBMIT ----
  const dup = await api('POST', `/student/exams/attempts/${attemptId}/submit`, studentToken, { idempotency_key: 'idem-e2e-1' });
  ok(dup.status === 201 && dup.body?.score_auto === 20 && dup.body?.state === 'grading', 'duplicate submit is idempotent (no re-grade)');

  // ---- BullMQ: AI suggestion job for the essay ----
  let aiScore: number | null = null;
  for (let i = 0; i < 20; i++) {
    const row = await client.query(`SELECT ai_suggested_score, id FROM exam_attempt_answers WHERE attempt_id=$1 AND manual_required=true`, [attemptId]);
    aiScore = row.rows[0]?.ai_suggested_score;
    if (aiScore !== null && aiScore !== undefined) break;
    await sleep(500);
  }
  ok(aiScore !== null && aiScore !== undefined, `AI grading job produced a suggestion (ai_suggested_score=${aiScore})`);

  // ---- MANUAL ESSAY GRADING ----
  const detail = await api('GET', `/teacher/exams/${examId}/attempts/${attemptId}`, teacherToken);
  const essayAnswer = (detail.body.answers as any[]).find((a) => a.type === 'essay');
  ok(!!essayAnswer && essayAnswer.manual_required === true, 'teacher sees the pending essay answer');
  const gradeRes = await api('POST', `/teacher/exams/${examId}/answers/${essayAnswer.answer_id}/grade`, teacherToken, { score: 8, feedback: 'Good' });
  ok(gradeRes.status === 201 && gradeRes.body?.state === 'graded' && gradeRes.body?.score_total === 28, `manual grade → GRADED, score_total=${gradeRes.body?.score_total} (expected 28)`);

  // ---- RESULT ----
  const result = await api('GET', `/student/exams/${examId}/result`, studentToken);
  ok(result.body?.available === true && result.body?.passed === true && result.body?.score_total === 28, `result available, passed, score_total=${result.body?.score_total}`);

  // ---- FAILURE: student without access ----
  if (lessonId) {
    const gatedExam = await buildExam(teacherToken, subjectId, 120, ['single_choice'], lessonId);
    const denied = await api('POST', `/student/exams/${gatedExam}/start`, studentToken);
    ok(denied.status === 403, `student without lesson access is blocked → ${denied.status}`);
  } else {
    console.log('ℹ️  no lesson available → skipping access-gating scenario');
  }

  // ---- FAILURE: concurrent start does not corrupt data ----
  const concExam = await buildExam(teacherToken, subjectId, 120, ['single_choice', 'true_false']);
  const [c1, c2] = await Promise.all([
    api('POST', `/student/exams/${concExam}/start`, studentToken),
    api('POST', `/student/exams/${concExam}/start`, studentToken),
  ]);
  const inProgress = await client.query(`SELECT count(*)::int c FROM exam_attempts WHERE exam_id=$1 AND student_id=$2 AND state='in_progress'`, [concExam, studentId]);
  ok(inProgress.rows[0].c === 1, `concurrent start created exactly 1 in-progress attempt (statuses ${c1.status}/${c2.status})`);

  // ---- FAILURE: expired exam triggers delayed auto-submit (real BullMQ delayed job) ----
  const shortExam = await buildExam(teacherToken, subjectId, 30, ['single_choice']);
  const shortStart = await api('POST', `/student/exams/${shortExam}/start`, studentToken);
  const shortAttemptId = shortStart.body.attempt_id as string;
  console.log(`⏳ waiting ~34s for delayed auto-submit job (duration 30s + grace 1s)...`);
  let autoState = '';
  let autoSubmitted = false;
  for (let i = 0; i < 40; i++) {
    const row = await client.query(`SELECT state, auto_submitted FROM exam_attempts WHERE id=$1`, [shortAttemptId]);
    autoState = row.rows[0]?.state;
    autoSubmitted = row.rows[0]?.auto_submitted;
    if (autoState !== 'in_progress') break;
    await sleep(1000);
  }
  ok(autoState !== 'in_progress' && autoSubmitted === true, `delayed auto-submit worker finalised the attempt → state=${autoState}, auto_submitted=${autoSubmitted}`);

  // ---- BullMQ job counts (Redis queues) ----
  const queues = {
    autosubmit: new Queue('exam-auto-submit', { connection: redisConn }),
    analytics: new Queue('exam-analytics', { connection: redisConn }),
    ai: new Queue('exam-ai-grading', { connection: redisConn }),
  };
  const counts = {
    autosubmit: await queues.autosubmit.getJobCounts(),
    analytics: await queues.analytics.getJobCounts(),
    ai: await queues.ai.getJobCounts(),
  };
  console.log('BullMQ job counts:', JSON.stringify(counts));
  ok((counts.analytics.completed ?? 0) >= 1, `analytics queue processed jobs (completed=${counts.analytics.completed})`);
  ok((counts.ai.completed ?? 0) >= 1, `ai-grading queue processed jobs (completed=${counts.ai.completed})`);
  ok((counts.autosubmit.completed ?? 0) >= 1, `auto-submit queue processed jobs (completed=${counts.autosubmit.completed})`);
  await Promise.all(Object.values(queues).map((qq) => qq.close()));

  console.log(`\n==== E2E RESULT: ${pass} passed, ${fail} failed ====`);
  await client.end();
}

main().catch((e) => { console.error('E2E error:', e); process.exitCode = 1; });
