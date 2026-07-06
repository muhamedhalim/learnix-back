/**
 * End-to-end driver for the Exams module against the RUNNING backend.
 * Seeds a teacher + student, logs in (CSRF double-submit), and exercises the
 * authoring flow. Extended per milestone slice. Run: `ts-node scripts/e2e-exams.ts`.
 */
import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { Client } from 'pg';

const BASE = 'http://localhost:3001/api/v1';
const SUBJECT_ID = process.env['E2E_SUBJECT_ID'] ?? '';
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
    [username, `E2E ${role}`, email, `0100000${Math.floor(Math.random() * 9000 + 1000)}`, hash, role],
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

async function api(
  method: string,
  path: string,
  token?: string,
  payload?: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (method !== 'GET') {
    headers['x-csrf-token'] = csrfToken;
    headers['Cookie'] = csrfCookie;
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function login(email: string): Promise<string> {
  const { status, body } = await api('POST', '/auth/login', undefined, { email, password: PASSWORD });
  const token = body?.data?.token ?? body?.token;
  if (status >= 400 || !token) throw new Error(`login failed (${status}): ${JSON.stringify(body)}`);
  return token as string;
}

const questions = (subjectId: string) => [
  { label: 'single_choice', type: 'single_choice', subject_id: subjectId, default_marks: 5,
    content: { prompt: { en: '2 + 2 = ?' }, options: [{ id: 'a', text: { en: '3' } }, { id: 'b', text: { en: '4' } }] },
    answer_key: { correctOptionId: 'b' } },
  { label: 'multiple_select', type: 'multiple_select', subject_id: subjectId, default_marks: 6,
    content: { prompt: { en: 'Pick the even numbers' }, options: [{ id: 'a', text: { en: '2' } }, { id: 'b', text: { en: '3' } }, { id: 'c', text: { en: '4' } }, { id: 'd', text: { en: '5' } }] },
    answer_key: { correctOptionIds: ['a', 'c'] } },
  { label: 'true_false', type: 'true_false', subject_id: subjectId, default_marks: 2,
    content: { prompt: { en: 'The earth is round.' } }, answer_key: { value: true } },
  { label: 'fill_blank', type: 'fill_blank', subject_id: subjectId, default_marks: 4,
    content: { prompt: { en: 'The capital of Egypt is {{1}}.' }, blanks: [{ id: '1' }] },
    answer_key: { blanks: [{ id: '1', accepted: ['Cairo'] }] } },
  { label: 'numeric', type: 'numeric', subject_id: subjectId, default_marks: 3,
    content: { prompt: { en: 'What is 6 x 7?' } }, answer_key: { value: 42, tolerance: 0 } },
  { label: 'essay', type: 'essay', subject_id: subjectId, default_marks: 10,
    content: { prompt: { en: 'Explain Newton\'s first law.' } }, answer_key: { modelAnswer: { en: 'An object stays at rest or in motion...' } } },
];

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env['DATABASE_URL'] });
  await client.connect();

  const subjectRow = SUBJECT_ID
    ? { rows: [{ id: SUBJECT_ID }] }
    : await client.query(`SELECT id FROM subjects WHERE deleted_at IS NULL LIMIT 1`);
  const subjectId = subjectRow.rows[0].id as string;
  console.log(`Using subject ${subjectId}`);

  const teacherId = await seedUser(client, 'teacher.e2e@test.local', 'teacher', 'teacher_e2e');
  const studentId = await seedUser(client, 'student.e2e@test.local', 'student', 'student_e2e');
  console.log(`Seeded teacher ${teacherId}, student ${studentId}`);

  await primeCsrf();
  const teacherToken = await login('teacher.e2e@test.local');
  ok(teacherToken.length > 0, 'teacher login returns a JWT');

  // ---- Authoring: create the 6 questions ----
  const created: Record<string, string> = {};
  for (const q of questions(subjectId)) {
    const { label, ...payload } = q;
    const res = await api('POST', '/teacher/questions', teacherToken, payload);
    ok(res.status === 201 && typeof res.body?.id === 'string', `create question [${label}] → ${res.status}`);
    if (res.body?.id) created[label] = res.body.id;
  }

  // Reject an invalid payload (single_choice with a bad correctOptionId)
  const bad = await api('POST', '/teacher/questions', teacherToken, {
    type: 'single_choice', subject_id: subjectId, default_marks: 1,
    content: { prompt: { en: 'x' }, options: [{ id: 'a', text: { en: 'A' } }, { id: 'b', text: { en: 'B' } }] },
    answer_key: { correctOptionId: 'zzz' },
  });
  ok(bad.status === 400, `invalid question payload rejected → ${bad.status}`);

  // ---- Authoring: create exam, section, attach, publish ----
  const examRes = await api('POST', '/teacher/exams', teacherToken, {
    title: 'E2E Exam', title_ar: 'امتحان', subject_id: subjectId, passing_marks: 15,
    config: { duration_seconds: 120, review_policy: 'after_graded' },
  });
  ok(examRes.status === 201 && examRes.body?.status === 'draft', `create exam (draft) → ${examRes.status}`);
  const examId = examRes.body.id as string;

  const sectionRes = await api('POST', `/teacher/exams/${examId}/sections`, teacherToken, { title: 'Section 1' });
  ok(sectionRes.status === 201, `add section → ${sectionRes.status}`);
  const sectionId = sectionRes.body.id as string;

  for (const [label, qid] of Object.entries(created)) {
    const res = await api('POST', `/teacher/exams/${examId}/questions`, teacherToken, {
      question_id: qid, section_id: sectionId,
    });
    ok(res.status === 201, `attach question [${label}] → ${res.status}`);
  }

  const beforePublish = await api('GET', `/teacher/exams/${examId}`, teacherToken);
  ok(beforePublish.body?.total_marks === 30, `total_marks recomputed = 30 (got ${beforePublish.body?.total_marks})`);
  ok((beforePublish.body?.exam_questions?.length ?? 0) === 6, `exam has 6 questions`);

  const publishRes = await api('POST', `/teacher/exams/${examId}/publish`, teacherToken);
  ok(publishRes.status === 201 && publishRes.body?.status === 'published', `publish → ${publishRes.body?.status}`);

  // ---- DB persistence checks ----
  const dbExam = await client.query(`SELECT status, total_marks FROM exams WHERE id=$1`, [examId]);
  ok(dbExam.rows[0]?.status === 'published' && Number(dbExam.rows[0]?.total_marks) === 30, 'DB: exam published, total_marks=30');
  const eqCount = await client.query(`SELECT count(*)::int AS c FROM exam_questions WHERE exam_id=$1`, [examId]);
  ok(eqCount.rows[0].c === 6, `DB: 6 exam_questions rows`);
  const versions = await client.query(`SELECT count(*)::int AS c FROM question_versions WHERE created_by=$1`, [teacherId]);
  ok(versions.rows[0].c >= 6, `DB: >=6 question_versions snapshots`);

  console.log(`\nEXAM_ID=${examId}\nSECTION_ID=${sectionId}\nTEACHER_ID=${teacherId}\nSTUDENT_ID=${studentId}`);
  await client.end();
}

main().catch((e) => {
  console.error('E2E error:', e);
  process.exitCode = 1;
});
