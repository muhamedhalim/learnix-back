/**
 * End-to-end driver for the public media proxy against the RUNNING backend.
 * Seeds a teacher, uploads a real image + a real private "book" PDF, sets a
 * lesson's thumbnail from the uploaded image key, and verifies:
 *  - the lesson DTO exposes `thumbnail_url` pointing at /api/v1/media/public/*
 *  - that URL actually streams the correct bytes/content-type from R2
 *  - the private book key is NOT reachable through the same endpoint
 *  - an unknown key in an allowed folder 404s
 * Run: `ts-node --transpile-only scripts/e2e-media.ts`.
 */
import 'dotenv/config';
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

async function seedTeacher(client: Client): Promise<string> {
  const hash = await bcrypt.hash(PASSWORD, 12);
  const email = 'e2e-media-teacher@example.com';
  const res = await client.query(
    `INSERT INTO users (username, name, email, phone, password_hash, role, status, is_active)
     VALUES ($1,$2,$3,$4,$5,'teacher','approved',true)
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, status='approved', is_active=true
     RETURNING id`,
    ['e2e-media-teacher', 'Media E2E Teacher', email, '01000009999', hash],
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, token: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  if (method !== 'GET') {
    headers['x-csrf-token'] = csrfToken;
    headers['Cookie'] = csrfCookie;
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// A tiny valid 1x1 red PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function uploadFile(
  token: string,
  path: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: contentType }), filename);
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-csrf-token': csrfToken, Cookie: csrfCookie },
    body: fd,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env['DATABASE_URL'] });
  await client.connect();

  const teacherId = await seedTeacher(client);
  const subjectRes = await client.query('SELECT id FROM subjects LIMIT 1');
  const subjectId = subjectRes.rows[0].id as string;

  await primeCsrf();
  const token = await login('e2e-media-teacher@example.com');

  console.log(`\n=== Setup: teacher=${teacherId} subject=${subjectId} ===\n`);

  // 1) Upload a real public image via the generic teacher image endpoint.
  const imgBytes = Buffer.from(PNG_BASE64, 'base64');
  const uploadRes = await uploadFile(token, '/teacher/uploads/image', 'thumb.png', 'image/png', imgBytes);
  ok(uploadRes.status === 201 || uploadRes.status === 200, `upload image → ${uploadRes.status}`);
  const uploadBody = uploadRes.body as { url?: string; key?: string; data?: { url?: string; key?: string } };
  const imageUrl = uploadBody.url ?? uploadBody.data?.url;
  const imageKey = uploadBody.key ?? uploadBody.data?.key;
  ok(typeof imageKey === 'string' && imageKey.startsWith('images/'), `upload response includes key → ${imageKey}`);
  ok(typeof imageUrl === 'string' && /r2\.cloudflarestorage\.com/.test(imageUrl ?? ''), `upload response url is the raw (unusable) R2 URL → ${imageUrl}`);

  // 2) Create a lesson using the KEY (not the raw url) as `thumbnail`.
  const createRes = await api('POST', '/teacher/lessons', token, {
    title: 'E2E Media Verification Lesson',
    title_ar: 'درس التحقق من الوسائط',
    subject_id: subjectId,
    price: 0,
    thumbnail: imageKey,
  });
  ok(createRes.status === 201 || createRes.status === 200, `create lesson → ${createRes.status} ${JSON.stringify(createRes.body)}`);
  const lessonBody = createRes.body as { id?: string; lesson?: { id?: string }; data?: { id?: string } };
  const lessonId = lessonBody.id ?? lessonBody.lesson?.id ?? lessonBody.data?.id;
  ok(typeof lessonId === 'string', `lesson id present → ${lessonId}`);

  // 3) Fetch it back and confirm thumbnail_url shape.
  const getRes = await api('GET', `/teacher/lessons/${lessonId}`, token);
  const getBody = getRes.body as { lesson?: Record<string, unknown>; data?: Record<string, unknown> };
  const lesson = getBody.lesson ?? getBody.data ?? (getRes.body as Record<string, unknown>);
  const thumbnailUrl = lesson['thumbnail_url'] as string | null;
  ok(getRes.status === 200, `fetch lesson → ${getRes.status}`);
  ok(lesson['thumbnail'] === imageKey, `lesson.thumbnail stores the bare KEY, not a URL → ${String(lesson['thumbnail'])}`);
  ok(
    typeof thumbnailUrl === 'string' && thumbnailUrl.startsWith(`${BASE}/media/public/${imageKey}`),
    `lesson.thumbnail_url points at the media proxy → ${thumbnailUrl}`,
  );

  // 4) Hit the media endpoint directly and confirm it streams the real bytes.
  const mediaRes = await fetch(thumbnailUrl as string);
  const mediaBuf = Buffer.from(await mediaRes.arrayBuffer());
  ok(mediaRes.status === 200, `GET thumbnail_url directly → ${mediaRes.status}`);
  ok(mediaRes.headers.get('content-type') === 'image/png', `Content-Type preserved → ${mediaRes.headers.get('content-type')}`);
  ok(mediaBuf.equals(imgBytes), `streamed bytes match the uploaded PNG exactly (${mediaBuf.length} bytes)`);
  ok(
    (mediaRes.headers.get('cache-control') ?? '').includes('max-age'),
    `Cache-Control set → ${mediaRes.headers.get('cache-control')}`,
  );

  // 5) Unknown key in an allowed folder → 404.
  const missingRes = await fetch(`${BASE}/media/public/images/does-not-exist-${Date.now()}.png`);
  ok(missingRes.status === 404, `unknown key 404s → ${missingRes.status}`);

  // 6) Private folder ('books') is never reachable through this endpoint,
  //    even with a REAL key that genuinely exists in storage.
  const bookBytes = Buffer.from('%PDF-1.4 fake pdf for e2e', 'utf8');
  const bookUploadRes = await uploadFile(token, '/teacher/uploads/book-file', 'book.pdf', 'application/pdf', bookBytes);
  const bookBody = bookUploadRes.body as { key?: string; data?: { key?: string } };
  const bookKey = bookBody.key ?? bookBody.data?.key;
  ok(typeof bookKey === 'string' && bookKey.startsWith('books/'), `upload private book → key=${bookKey}`);
  const bookMediaRes = await fetch(`${BASE}/media/public/${bookKey}`);
  ok(bookMediaRes.status === 404, `private 'books/' key is NOT reachable via /media/public (private namespace excluded) → ${bookMediaRes.status}`);

  // 7) Legacy data: a lesson whose `thumbnail` column still holds the OLD
  //    broken full R2 URL (bucket-name-in-path) must normalize correctly —
  //    not just pass the pre-existing bug through.
  const legacyUrl = `https://16d2fd453f3d38a9118e0633fff7642d.r2.cloudflarestorage.com/learnix/${imageKey}`;
  await client.query('UPDATE lessons SET thumbnail = $1 WHERE id = $2', [legacyUrl, lessonId]);
  const legacyGetRes = await api('GET', `/teacher/lessons/${lessonId}`, token);
  const legacyBody = legacyGetRes.body as { lesson?: Record<string, unknown>; data?: Record<string, unknown> };
  const legacyLesson = legacyBody.lesson ?? legacyBody.data ?? (legacyGetRes.body as Record<string, unknown>);
  ok(
    legacyLesson['thumbnail_url'] === `${BASE}/media/public/${imageKey}`,
    `legacy broken R2 URL (with bucket in path) normalizes back to the correct proxied URL → ${String(legacyLesson['thumbnail_url'])}`,
  );
  const legacyMediaRes = await fetch(legacyLesson['thumbnail_url'] as string);
  ok(legacyMediaRes.status === 200, `legacy-normalized thumbnail_url actually resolves → ${legacyMediaRes.status}`);

  // 8) A genuinely external URL (not ours) must pass through unchanged.
  const externalUrl = 'https://picsum.photos/200';
  await client.query('UPDATE lessons SET thumbnail = $1 WHERE id = $2', [externalUrl, lessonId]);
  const externalGetRes = await api('GET', `/teacher/lessons/${lessonId}`, token);
  const externalBody = externalGetRes.body as { lesson?: Record<string, unknown>; data?: Record<string, unknown> };
  const externalLesson = externalBody.lesson ?? externalBody.data ?? (externalGetRes.body as Record<string, unknown>);
  ok(
    externalLesson['thumbnail_url'] === externalUrl,
    `genuinely external thumbnail URL passes through unchanged → ${String(externalLesson['thumbnail_url'])}`,
  );

  await client.end();
  console.log('\n=== Done ===\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
