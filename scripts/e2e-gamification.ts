/**
 * End-to-end driver for the gamification MVP against the RUNNING backend.
 * Seeds a teacher + student + questions of varying difficulty, then exercises
 * the practice → grade → award pipeline and asserts the economy invariants:
 *   - first correct solve awards XP once (base + streak bonus)
 *   - a repeat of the same question awards NO XP and moves NO rating (anti-farm)
 *   - a first-attempt WRONG answer lowers rating but grants no XP
 *   - rapid (sub-floor) answers are flagged suspicious and earn nothing
 *   - public leaderboard + public /u/:username reflect the state (no auth)
 * Run: `ts-node --transpile-only scripts/e2e-gamification.ts`.
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
    [username, `Gami ${role}`, email, `0100${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`, hash, role],
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
async function api(method: string, path: string, token: string | null, payload?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
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

async function seedQuestion(
  client: Client,
  teacherId: string,
  subjectId: string,
  difficulty: 'easy' | 'medium' | 'hard' | 'expert',
): Promise<{ id: string; correctOptionId: string }> {
  const a = randomUUID();
  const b = randomUUID();
  const content = {
    prompt: { en: `Pick A (${difficulty})`, ar: '' },
    options: [
      { id: a, text: { en: 'A', ar: '' } },
      { id: b, text: { en: 'B', ar: '' } },
    ],
  };
  const answerKey = { correctOptionId: a };
  const res = await client.query(
    `INSERT INTO questions (teacher_id, subject_id, type, difficulty, content, answer_key, default_marks, tags, current_version, is_active)
     VALUES ($1,$2,'single_choice',$3,$4,$5,1,'{}',1,true) RETURNING id`,
    [teacherId, subjectId, difficulty, JSON.stringify(content), JSON.stringify(answerKey)],
  );
  return { id: res.rows[0].id as string, correctOptionId: a };
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env['DATABASE_URL'] });
  await client.connect();

  const teacherId = await seedUser(client, 'e2e-gami-teacher@example.com', 'teacher', 'e2e-gami-teacher');
  const studentEmail = 'e2e-gami-student@example.com';
  const studentId = await seedUser(client, studentEmail, 'student', 'e2egamistudent');
  // Ensure a fresh game state for deterministic assertions.
  await client.query('DELETE FROM question_solves WHERE user_id = $1', [studentId]);
  await client.query('DELETE FROM xp_events WHERE user_id = $1', [studentId]);
  await client.query('DELETE FROM student_question_states WHERE user_id = $1', [studentId]);
  await client.query('DELETE FROM student_subject_ratings WHERE user_id = $1', [studentId]);
  await client.query('DELETE FROM student_game_profiles WHERE user_id = $1', [studentId]);
  // Give the student demographic fields (for geo leaderboard).
  await client.query(
    `INSERT INTO student_profiles (user_id, parent_phone, grade_level, governorate, school, notification_settings)
     VALUES ($1,'01000000000','grade_10','Cairo','E2E School','{}')
     ON CONFLICT (user_id) DO UPDATE SET governorate='Cairo', school='E2E School', grade_level='grade_10'`,
    [studentId],
  );

  const subjectRes = await client.query('SELECT id FROM subjects LIMIT 1');
  const subjectId = subjectRes.rows[0].id as string;

  const easy = await seedQuestion(client, teacherId, subjectId, 'easy');
  const hard = await seedQuestion(client, teacherId, subjectId, 'hard');
  await client.end();

  await primeCsrf();
  const token = await login(studentEmail);

  console.log(`\n=== Setup: student=${studentId} subject=${subjectId} ===\n`);

  // 1) First correct solve of the EASY question → base(10) + streak daily(25) = 35.
  const solve1 = await api('POST', '/student/practice/answer', token, {
    question_id: easy.id,
    response: { optionId: easy.correctOptionId },
    time_ms: 9000,
  });
  ok(solve1.status === 200 || solve1.status === 201, `solve easy (correct, first) → ${solve1.status}`);
  ok(solve1.body?.isCorrect === true, 'easy graded correct');
  ok(solve1.body?.firstSolve === true && solve1.body?.firstAttempt === true, 'flagged first solve + first attempt');
  ok(solve1.body?.xpAwarded === 35, `awarded 35 XP (10 base + 25 streak) → got ${solve1.body?.xpAwarded}`);
  ok(solve1.body?.ratingDelta > 0, `rating rose on correct first attempt → ${solve1.body?.ratingDelta}`);
  ok(solve1.body?.streak === 1 && solve1.body?.combo === 1, 'streak=1, combo=1');
  ok(typeof solve1.body?.solution?.correctOptionId === 'string', 'post-answer solution revealed');

  // 2) Repeat the SAME easy question → no XP, no rating movement (anti-farm).
  const solve2 = await api('POST', '/student/practice/answer', token, {
    question_id: easy.id,
    response: { optionId: easy.correctOptionId },
    time_ms: 9000,
  });
  ok(solve2.body?.firstAttempt === false, 'repeat flagged not-first-attempt');
  ok(solve2.body?.xpAwarded === 0, `repeat awards 0 XP → got ${solve2.body?.xpAwarded}`);
  ok(solve2.body?.ratingDelta === 0, `repeat moves 0 rating → got ${solve2.body?.ratingDelta}`);

  // 3) First-attempt WRONG on the HARD question → rating drops, 0 XP.
  const ratingBefore = solve2.body?.globalRating as number;
  const solve3 = await api('POST', '/student/practice/answer', token, {
    question_id: hard.id,
    response: { optionId: randomUUID() }, // not the correct option
    time_ms: 9000,
  });
  ok(solve3.body?.isCorrect === false, 'hard graded wrong');
  ok(solve3.body?.firstAttempt === true, 'wrong answer still a first attempt');
  ok(solve3.body?.xpAwarded === 0, `wrong first attempt awards 0 XP → got ${solve3.body?.xpAwarded}`);
  ok(solve3.body?.ratingDelta < 0, `wrong first attempt lowers rating → ${solve3.body?.ratingDelta}`);
  ok(solve3.body?.globalRating < ratingBefore, 'global rating decreased after the miss');
  ok(solve3.body?.combo === 0, 'combo reset to 0 on wrong answer');

  // 4) Rapid (sub-floor) answer is flagged suspicious and earns nothing. Seed a
  //    fresh question so it is genuinely a first attempt.
  const client2 = new Client({ connectionString: process.env['DATABASE_URL'] });
  await client2.connect();
  const speedy = await seedQuestion(client2, teacherId, subjectId, 'medium');
  await client2.end();
  const solve4 = await api('POST', '/student/practice/answer', token, {
    question_id: speedy.id,
    response: { optionId: speedy.correctOptionId },
    time_ms: 200, // under MIN_SOLVE_TIME_MS
  });
  ok(solve4.body?.suspicious === true, 'sub-floor answer flagged suspicious');
  ok(solve4.body?.xpAwarded === 0 && solve4.body?.ratingDelta === 0, 'suspicious answer earns nothing');

  // 5) My game profile reflects the accumulated state.
  const me = await api('GET', '/student/game/profile', token);
  ok(me.status === 200, `GET my game profile → ${me.status}`);
  ok(me.body?.profile?.total_solved >= 4, `total_solved counts every attempt → ${me.body?.profile?.total_solved}`);
  ok(me.body?.profile?.xp === 35, `profile XP === 35 → got ${me.body?.profile?.xp}`);
  ok(me.body?.rank_tier?.slug === 'bronze', `rank tier resolved → ${me.body?.rank_tier?.slug}`);

  // 6) PUBLIC leaderboard (no auth) includes the student.
  const board = await api('GET', '/leaderboard?scope=global&metric=rating&limit=100', null);
  ok(board.status === 200, `public leaderboard (no auth) → ${board.status}`);
  const onBoard = (board.body?.rows ?? []).some((r: { username: string }) => r.username === 'e2egamistudent');
  ok(onBoard, 'student appears on the public global rating board');

  // 7) Governorate-scoped board (geo leaderboard).
  const geo = await api('GET', '/leaderboard?scope=governorate&governorate=Cairo&limit=100', null);
  ok(geo.status === 200, `governorate board → ${geo.status}`);
  ok((geo.body?.rows ?? []).some((r: { username: string }) => r.username === 'e2egamistudent'), 'student appears on the Cairo governorate board');

  // 8) PUBLIC profile (no auth).
  const pub = await api('GET', '/u/e2egamistudent', null);
  ok(pub.status === 200, `public /u/:username (no auth) → ${pub.status}`);
  ok(pub.body?.xp === 35 && pub.body?.total_solved >= 4, 'public profile reflects xp + solved');
  ok(pub.body?.governorate === 'Cairo' && pub.body?.school === 'E2E School', 'public profile shows opt-in geo fields');
  ok(Array.isArray(pub.body?.recent_activity) && pub.body.recent_activity.length >= 4, 'public profile lists recent activity');
  ok(pub.body?.email === undefined && pub.body?.phone === undefined, 'public profile leaks no PII (email/phone)');

  console.log('\n=== Done ===\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
