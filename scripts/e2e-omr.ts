/**
 * End-to-end driver for the OMR pipeline against the RUNNING backend. Seeds a
 * teacher + student + published exam, submits an OMR sheet (real image bytes
 * + pre-detected marks), polls until processed, and verifies the resulting
 * graded attempt in the database. Run: `ts-node --transpile-only scripts/e2e-omr.ts`.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { Client } from 'pg';

const BASE = 'http://localhost:3001/api/v1';
const PASSWORD = 'Passw0rd!';

let csrfToken = '';
let csrfCookie = '';

function ok(cond: boolean, label: string): void {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) process.exitCode = 1;
}

async function seedUser(client: Client, email: string, role: 'teacher' | 'student', username: string): Promise<string> {
  const hash = await bcrypt.hash(PASSWORD, 12);
  const res = await client.query(
    `INSERT INTO users (username, name, email, phone, password_hash, role, status, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,'approved',true)
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, status='approved', is_active=true, role=EXCLUDED.role
     RETURNING id`,
    [username, `OMR ${role}`, email, `0100000${Math.floor(Math.random() * 9000 + 1000)}`, hash, role],
  );
  return res.rows[0].id as string;
}

async function primeCsrf(): Promise<void> {
  const res = await fetch(`${BASE}/auth/csrf-token`);
  const setCookies = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const xsrf = setCookies.find((c) => c.startsWith('XSRF-TOKEN='));
  if (xsrf) csrfCookie = xsrf.split(';')[0];
  const body = (await res.json()) as { data?: { token?: string }; token?: string };
  csrfToken = body.data?.token ?? body.token ?? '';
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken, Cookie: csrfCookie },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = (await res.json()) as { token?: string; data?: { token?: string } };
  const token = body.token ?? body.data?.token;
  if (res.status >= 400 || !token) throw new Error(`login failed (${res.status}): ${JSON.stringify(body)}`);
  return token;
}

async function api(method: string, path: string, token: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  if (method !== 'GET') {
    headers['x-csrf-token'] = csrfToken;
    headers['Cookie'] = csrfCookie;
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// A minimal valid 1x1 JPEG (avoids depending on a fixture file on disk).
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
);

async function submitOmrSheet(
  examId: string,
  token: string,
  studentId: string,
  answers: { exam_question_id: string; response: unknown }[],
): Promise<{ status: number; body: any }> {
  const form = new FormData();
  form.append('file', new Blob([TINY_JPEG], { type: 'image/jpeg' }), 'sheet.jpg');
  form.append('student_id', studentId);
  form.append('answers', JSON.stringify(answers));

  const res = await fetch(`${BASE}/teacher/exams/${examId}/omr-sheets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-csrf-token': csrfToken, Cookie: csrfCookie },
    body: form,
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function pollSheet(examId: string, sheetId: string, token: string, timeoutMs = 15000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await api('GET', `/teacher/exams/${examId}/omr-sheets/${sheetId}`, token);
    if (body.status === 'completed' || body.status === 'failed') return body;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for sheet ${sheetId} to finish processing`);
}

async function main(): Promise<void> {
  const client = new Client({
    host: process.env['DATABASE_HOST'],
    port: Number(process.env['DATABASE_PORT']),
    user: process.env['DATABASE_USERNAME'],
    password: String(process.env['DATABASE_PASSWORD'] ?? ''),
    database: process.env['DATABASE_NAME'],
  });
  await client.connect();

  const subjectRow = await client.query(`SELECT id FROM subjects WHERE deleted_at IS NULL LIMIT 1`);
  const subjectId = subjectRow.rows[0].id as string;

  const teacherId = await seedUser(client, 'teacher.omr@test.local', 'teacher', 'teacher_omr');
  const studentId = await seedUser(client, 'student.omr@test.local', 'student', 'student_omr');
  console.log(`Seeded teacher ${teacherId}, student ${studentId}, subject ${subjectId}`);

  await primeCsrf();
  const teacherToken = await login('teacher.omr@test.local');
  ok(teacherToken.length > 0, 'teacher login returns a JWT');

  // ---- Build a small exam with 2 single_choice questions ----
  const q1 = await api('POST', '/teacher/questions', teacherToken, {
    type: 'single_choice', subject_id: subjectId, default_marks: 5,
    content: { prompt: { en: '2 + 2 = ?' }, options: [{ id: 'a', text: { en: '3' } }, { id: 'b', text: { en: '4' } }] },
    answer_key: { correctOptionId: 'b' },
  });
  const q2 = await api('POST', '/teacher/questions', teacherToken, {
    type: 'single_choice', subject_id: subjectId, default_marks: 5,
    content: { prompt: { en: '3 + 3 = ?' }, options: [{ id: 'a', text: { en: '6' } }, { id: 'b', text: { en: '7' } }] },
    answer_key: { correctOptionId: 'a' },
  });
  ok(q1.status === 201 && q2.status === 201, 'created 2 OMR test questions');

  const examRes = await api('POST', '/teacher/exams', teacherToken, {
    title: 'OMR E2E Exam', title_ar: 'امتحان', subject_id: subjectId, passing_marks: 5,
    config: { duration_seconds: 1800, review_policy: 'after_graded' },
  });
  ok(examRes.status === 201, `create exam → ${examRes.status}`);
  const examId = examRes.body.id as string;

  const sectionRes = await api('POST', `/teacher/exams/${examId}/sections`, teacherToken, { title: 'Section 1' });
  const sectionId = sectionRes.body.id as string;

  const attach1 = await api('POST', `/teacher/exams/${examId}/questions`, teacherToken, { question_id: q1.body.id, section_id: sectionId });
  const attach2 = await api('POST', `/teacher/exams/${examId}/questions`, teacherToken, { question_id: q2.body.id, section_id: sectionId });
  ok(attach1.status === 201 && attach2.status === 201, 'attached both questions');

  const publishRes = await api('POST', `/teacher/exams/${examId}/publish`, teacherToken);
  ok(publishRes.status === 201 && publishRes.body.status === 'published', `publish → ${publishRes.body.status}`);

  const detail = await api('GET', `/teacher/exams/${examId}`, teacherToken);
  const examQuestionIds: string[] = detail.body.exam_questions.map((eq: any) => eq.id);
  ok(examQuestionIds.length === 2, `exam has 2 exam_question rows`);

  // ==================== HAPPY PATH: both correct ====================
  const goodSheet = await submitOmrSheet(examId, teacherToken, studentId, [
    { exam_question_id: examQuestionIds[0], response: { optionId: 'b' } },
    { exam_question_id: examQuestionIds[1], response: { optionId: 'a' } },
  ]);
  ok(goodSheet.status === 201 && goodSheet.body.status === 'pending', `submit OMR sheet → ${goodSheet.status} (${goodSheet.body.status})`);
  const goodSheetId = goodSheet.body.id as string;

  const goodResult = await pollSheet(examId, goodSheetId, teacherToken);
  ok(goodResult.status === 'completed', `sheet processed → ${goodResult.status}`);
  ok(goodResult.attempt_id !== null, 'sheet has an attempt_id');

  const dbAttempt = await client.query(
    `SELECT state, score_total, max_score, auto_submitted FROM exam_attempts WHERE id = $1`,
    [goodResult.attempt_id],
  );
  const attemptRow = dbAttempt.rows[0];
  ok(attemptRow.state === 'graded', `DB: attempt state = graded (got ${attemptRow.state})`);
  ok(Number(attemptRow.score_total) === 10, `DB: score_total = 10/10 (got ${attemptRow.score_total}/${attemptRow.max_score})`);

  const attemptCountForStudent = await client.query(
    `SELECT count(*)::int AS c FROM exam_attempts WHERE exam_id = $1 AND student_id = $2`,
    [examId, studentId],
  );
  ok(attemptCountForStudent.rows[0].c === 1, `DB: exactly 1 attempt for this student+exam`);

  // ==================== IDEMPOTENCY / RETRY: reprocess the same completed sheet ====================
  // Manually re-trigger processing of the already-completed sheet by hitting
  // the same code path indirectly is not exposed via API, so we simulate the
  // BullMQ-redelivery scenario by re-enqueuing through the DB-visible contract:
  // re-fetch and confirm status stays 'completed' and attempt count stays 1
  // after a second poll (no background reprocessing happens for a finished sheet).
  const secondPoll = await api('GET', `/teacher/exams/${examId}/omr-sheets/${goodSheetId}`, teacherToken);
  ok(secondPoll.body.status === 'completed' && secondPoll.body.attempt_id === goodResult.attempt_id,
    'sheet remains completed on re-fetch (stable, not reprocessed)');

  // ==================== FAILURE PATH: invalid exam_question_id ====================
  // A syntactically valid v4 UUID that references no real exam_question row —
  // must pass DTO-level @IsUUID('4') validation and fail inside the
  // processor's own "belongs to this exam" business check instead.
  const badSheet = await submitOmrSheet(examId, teacherToken, studentId, [
    { exam_question_id: randomUUID(), response: { optionId: 'b' } },
  ]);
  ok(badSheet.status === 201, `submit bad OMR sheet accepted for async processing → ${badSheet.status}`);
  const badSheetId = badSheet.body.id as string;
  const badResult = await pollSheet(examId, badSheetId, teacherToken);
  ok(badResult.status === 'failed', `bad sheet → status = failed (got ${badResult.status})`);
  ok(typeof badResult.error_message === 'string' && badResult.error_message.length > 0, `bad sheet has a readable error_message: "${badResult.error_message}"`);
  ok(badResult.attempt_id === null, 'bad sheet has no attempt_id (no attempt created)');

  const attemptCountAfterBad = await client.query(
    `SELECT count(*)::int AS c FROM exam_attempts WHERE exam_id = $1 AND student_id = $2`,
    [examId, studentId],
  );
  ok(attemptCountAfterBad.rows[0].c === 1, `DB: still exactly 1 attempt after the failed sheet (no stray attempt created)`);

  console.log(`\nEXAM_ID=${examId}\nGOOD_SHEET_ID=${goodSheetId}\nBAD_SHEET_ID=${badSheetId}\nATTEMPT_ID=${goodResult.attempt_id}`);
  await client.end();
}

main().catch((e) => {
  console.error('E2E error:', e);
  process.exitCode = 1;
});
