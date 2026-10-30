/**
 * Seeds the LMS core for load testing: users, subjects, lessons, published packages, and paid enrollments
 * (order + payment + entitlement + package_purchase + ledger), lesson progress, notifications and activity logs.
 * Bulk server-side `INSERT ... SELECT` over generate_series, in chunks, so M/L finish in minutes not hours.
 *
 * NOT SEEDED HERE (deliberate): exams, questions and attempts. Their `jsonb` shapes (exam config, question
 * content/answer_key) are validated by the exam services, so k6 `setup()` creates exam content through the real
 * teacher API instead, and a follow-up step adds attempt volume once that content exists. Marketplace volume has
 * its own seeder (`seed:marketplace-load`).
 *
 * USAGE (database must already be built: npm run loadtest:db:build)
 *   DATABASE_URL=postgres://postgres:lms_load_password@localhost:55433/lms_load npm run seed:lms-load -- --profile=S
 *   profiles: S (CI/smoke) | M (local baseline) | L (EXPLAIN, pagination)
 *
 * SAFETY: refuses unless the database name contains "load" AND the host is local; refuses if already seeded
 * (recreate with `npm run loadtest:db:build -- --recreate`). Every generated account ends in
 * `@load.learnix.invalid` (.invalid is reserved by RFC 2606, so mail can never be delivered) and shares one
 * synthetic password written to learnix-infra/loadtest/.data/seed-manifest.json (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import bcrypt from 'bcryptjs';
import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';

loadDotenv({ quiet: true });

const PASSWORD = 'LoadTest!2026';
const EMAIL_DOMAIN = 'load.learnix.invalid';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

interface Profile {
  students: number;
  teachers: number;
  subjects: number;
  lessonsPerTeacher: number;
  packagesPerTeacher: number;
  lessonsPerPackage: number;
  enrollmentsPerStudent: number;
  notificationsPerStudent: number;
  activityLogs: number;
}

const PROFILES: Record<string, Profile> = {
  S: {
    students: 200,
    teachers: 5,
    subjects: 8,
    lessonsPerTeacher: 40,
    packagesPerTeacher: 4,
    lessonsPerPackage: 10,
    enrollmentsPerStudent: 3,
    notificationsPerStudent: 50,
    activityLogs: 10_000,
  },
  M: {
    students: 20_000,
    teachers: 50,
    subjects: 20,
    lessonsPerTeacher: 200,
    packagesPerTeacher: 10,
    lessonsPerPackage: 20,
    enrollmentsPerStudent: 5,
    notificationsPerStudent: 100,
    activityLogs: 1_000_000,
  },
  L: {
    students: 100_000,
    teachers: 200,
    subjects: 20,
    lessonsPerTeacher: 200,
    packagesPerTeacher: 10,
    lessonsPerPackage: 20,
    enrollmentsPerStudent: 5,
    notificationsPerStudent: 100,
    activityLogs: 5_000_000,
  },
};

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): { profileName: string; profile: Profile } {
  const raw =
    argv
      .find((a) => a.startsWith('--profile='))
      ?.split('=')[1]
      ?.toUpperCase() ?? 'S';
  const profile = PROFILES[raw];
  if (profile === undefined) fail(`Unknown --profile=${raw}. Use S, M or L.`);
  return { profileName: raw, profile };
}

function assertSafeTarget(): string {
  const raw = process.env['DATABASE_URL'];
  if (raw === undefined || raw.trim() === '') fail('DATABASE_URL is not set.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('DATABASE_URL is not a valid URL.');
  }
  const database = url.pathname.replace(/^\//, '').toLowerCase();
  if (!/load/.test(database))
    fail(`Refusing to seed "${database}": the database name must contain "load".`);
  if (!LOCAL_HOSTS.has(url.hostname))
    fail(`Refusing to seed host "${url.hostname}": only a local database is allowed.`);
  return raw;
}

/** Runs `fn(lo, hi)` for consecutive 1-based inclusive ranges covering 1..total. */
async function inChunks(
  total: number,
  size: number,
  fn: (lo: number, hi: number) => Promise<void>,
): Promise<void> {
  for (let lo = 1; lo <= total; lo += size) {
    await fn(lo, Math.min(lo + size - 1, total));
  }
}

async function main(): Promise<void> {
  const databaseUrl = assertSafeTarget();
  const { profileName, profile: p } = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const log = (message: string): void =>
    console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);

  const db = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []): Promise<number> =>
    (await db.query(sql, params)).rowCount ?? 0;

  try {
    const seeded = await db.query(
      `SELECT 1 FROM users WHERE email LIKE '%@${EMAIL_DOMAIN}' LIMIT 1`,
    );
    if ((seeded.rowCount ?? 0) > 0) {
      fail('Already seeded. Recreate the database first: npm run loadtest:db:build -- --recreate');
    }

    log(`hashing the shared synthetic password (bcrypt, 12 rounds, same cost as production)`);
    const hash = bcrypt.hashSync(PASSWORD, 12);

    // ---- subjects -------------------------------------------------------------------------------------------
    await q(
      `INSERT INTO subjects (name) SELECT 'Load Subject ' || lpad(n::text, 2, '0') FROM generate_series(1, $1) n`,
      [p.subjects],
    );
    log(`subjects: ${p.subjects}`);

    // ---- users ----------------------------------------------------------------------------------------------
    // finance_permissions DEFAULTS to every finance permission (migration), so non-admins must set '[]' explicitly.
    // Parameters: $1 password hash, $2..$3 inclusive ordinal range. `grantFinance` keeps the column default (all
    // permissions) for the admin only.
    const userInsert = (
      role: string,
      label: string,
      phonePrefix: string,
      grantFinance: boolean,
    ): string => `
      INSERT INTO users (username, name, first_name, last_name, email, phone, password_hash, role, status, is_active,
                         preferred_language${grantFinance ? '' : ', finance_permissions'})
      SELECT '${label}' || n, 'Load ${label} ' || n, 'Load' || n, '${label}', '${label}' || n || '@${EMAIL_DOMAIN}',
             '${phonePrefix}' || lpad(n::text, 8, '0'), $1, '${role}', 'approved', true,
             (CASE WHEN n % 2 = 0 THEN 'en' ELSE 'ar' END)::users_preferred_language_enum${grantFinance ? '' : ", '[]'::jsonb"}
      FROM generate_series($2::int, $3::int) n`;
    await q(userInsert('admin', 'admin', '+2012', true), [hash, 1, 1]);
    await q(userInsert('call_center', 'callcenter', '+2013', false), [hash, 1, 3]);
    await q(userInsert('teacher', 'teacher', '+2011', false), [hash, 1, p.teachers]);
    await inChunks(p.students, 20_000, async (lo, hi) => {
      await q(userInsert('student', 'student', '+2010', false), [hash, lo, hi]);
    });
    log(`users: 1 admin, 3 call-center, ${p.teachers} teachers, ${p.students} students`);

    await q(
      `INSERT INTO teacher_profiles (user_id, qualifications, years_of_experience)
       SELECT id, 'Synthetic load-test qualification', 3 + (random() * 15)::int FROM users WHERE role = 'teacher'`,
    );
    await q(`INSERT INTO student_profiles (user_id) SELECT id FROM users WHERE role = 'student'`);

    // Session-scoped index maps: ordinal -> uuid, so later chunks join by number instead of by lookup.
    await q(
      `CREATE TEMP TABLE m_subject AS SELECT row_number() OVER (ORDER BY name)::int AS idx, id FROM subjects`,
    );
    await q(
      `CREATE TEMP TABLE m_teacher AS
       SELECT substring(username from 8)::int AS idx, id FROM users WHERE role = 'teacher'`,
    );
    await q(
      `CREATE TEMP TABLE m_student AS
       SELECT substring(username from 8)::int AS idx, id FROM users WHERE role = 'student'`,
    );
    await q(`CREATE UNIQUE INDEX ON m_student (idx)`);
    await q(`CREATE UNIQUE INDEX ON m_teacher (idx)`);

    await q(
      `INSERT INTO teacher_subjects (teacher_profile_id, subject_id)
       SELECT tp.id, s.id
       FROM teacher_profiles tp
       JOIN m_teacher t ON t.id = tp.user_id
       JOIN m_subject s ON s.idx IN (1 + (t.idx % $1), 1 + ((t.idx + 1) % $1))
       ON CONFLICT DO NOTHING`,
      [p.subjects],
    );

    // ---- lessons, packages ----------------------------------------------------------------------------------
    await q(
      `INSERT INTO lessons (title, teacher_id, subject_id, price, duration)
       SELECT 'Load Lesson ' || t.idx || '-' || l.n, t.id, s.id, 50 + (l.n % 10) * 10, 1200 + (l.n % 10) * 60
       FROM m_teacher t
       CROSS JOIN generate_series(1, $1) l(n)
       JOIN m_subject s ON s.idx = 1 + ((t.idx + l.n) % $2)`,
      [p.lessonsPerTeacher, p.subjects],
    );
    await q(`CREATE TEMP TABLE m_lesson AS
             SELECT l.id, t.idx AS teacher_idx, substring(l.title from '[0-9]+$')::int AS n
             FROM lessons l JOIN m_teacher t ON t.id = l.teacher_id WHERE l.title LIKE 'Load Lesson %'`);
    await q(`CREATE INDEX ON m_lesson (teacher_idx, n)`);
    log(`lessons: ${p.teachers * p.lessonsPerTeacher}`);

    await q(
      `INSERT INTO lesson_packages (title, title_ar, teacher_id, subject_id, price, status, is_active, published_at)
       SELECT 'Load Course ' || t.idx || '-' || k.n, 'دورة تحميل ' || t.idx || '-' || k.n, t.id, s.id,
              300 + k.n * 50, 'published', true, now() - (k.n || ' days')::interval
       FROM m_teacher t
       CROSS JOIN generate_series(1, $1) k(n)
       JOIN m_subject s ON s.idx = 1 + ((t.idx + k.n) % $2)`,
      [p.packagesPerTeacher, p.subjects],
    );
    await q(`CREATE TEMP TABLE m_package AS
             SELECT pk.id, t.idx AS teacher_idx, substring(pk.title from '[0-9]+$')::int AS pidx,
                    pk.teacher_id, pk.price, pk.title, pk.title_ar
             FROM lesson_packages pk JOIN m_teacher t ON t.id = pk.teacher_id WHERE pk.title LIKE 'Load Course %'`);
    await q(`CREATE INDEX ON m_package (teacher_idx, pidx)`);
    await q(
      `INSERT INTO lesson_package_items (package_id, lesson_id, order_index)
       SELECT pk.id, l.id, g.n - 1
       FROM m_package pk
       CROSS JOIN generate_series(1, $1) g(n)
       JOIN m_lesson l ON l.teacher_idx = pk.teacher_idx
                      AND l.n = 1 + (((pk.pidx - 1) * $1 + g.n - 1) % $2)`,
      [p.lessonsPerPackage, p.lessonsPerTeacher],
    );
    // A purchasable package carries one locked course version (payment-finalization.service.ts freezes the live
    // curriculum into course_version_items on first purchase and refuses a package without current_version_id).
    await q(
      `INSERT INTO course_versions (package_id, version_number, locked_at) SELECT id, 1, now() FROM m_package`,
    );
    await q(
      `UPDATE lesson_packages pk SET current_version_id = v.id
       FROM course_versions v WHERE v.package_id = pk.id AND pk.title LIKE 'Load Course %'`,
    );
    await q(
      `INSERT INTO course_version_items (version_id, lesson_id, order_index)
       SELECT v.id, i.lesson_id, i.order_index
       FROM course_versions v JOIN lesson_package_items i ON i.package_id = v.package_id`,
    );
    log(`packages: ${p.teachers * p.packagesPerTeacher} (each with one locked course version)`);

    // ---- enrollments ------------------------------------------------------------------------------------------
    // Teacher 1 is the "whale": ~30% of all enrollments, so owner-isolation tests have a genuinely hot owner.
    // order + payment + entitlement + package_purchase + 3 ledger entries are written together, as the real
    // finalisation does (payments/services/payment-finalization.service.ts). Playback reads entitlements; the
    // analytics SQL still reads package_purchases, so both must exist.
    let enrollments = 0;
    await inChunks(p.students, 5_000, async (lo, hi) => {
      await q(`DROP TABLE IF EXISTS m_enroll`);
      await q(
        `CREATE TEMP TABLE m_enroll AS
         SELECT DISTINCT ON (s.id, pk.id)
                s.id AS student_id, pk.id AS package_id, pk.teacher_id, pk.price, pk.title, pk.title_ar,
                gen_random_uuid() AS order_id, gen_random_uuid() AS payment_id,
                (50000 + pk.pidx * 5000)::bigint AS amount_minor,
                now() - ((s.idx * 7 + j.n) % 120 || ' days')::interval AS paid_at
         FROM m_student s
         CROSS JOIN generate_series(1, $3::int) j(n)
         JOIN m_package pk
           ON pk.teacher_idx = CASE WHEN (s.idx * 7 + j.n) % 10 < 3 OR $4::int = 1 THEN 1
                                    ELSE 2 + ((s.idx + j.n) % ($4::int - 1)) END
          AND pk.pidx = 1 + ((s.idx * 3 + j.n) % $5::int)
         WHERE s.idx BETWEEN $1 AND $2
         ORDER BY s.id, pk.id`,
        [lo, hi, p.enrollmentsPerStudent, p.teachers, p.packagesPerTeacher],
      );
      await q(
        `INSERT INTO orders (order_number, student_id, teacher_id, item_type, item_id, quantity, original_amount_minor,
                             discount_amount_minor, final_amount_minor, refunded_amount_minor, currency, payment_channel,
                             status, product_title_snapshot, product_title_ar_snapshot, platform_commission_bps,
                             platform_commission_minor, teacher_earning_minor, id, created_at, paid_at)
         SELECT 'LD-' || replace(order_id::text, '-', ''), student_id, teacher_id, 'package', package_id, 1,
                amount_minor, 0, amount_minor, 0, 'EGP', 'gateway', 'paid', title, title_ar, 3000,
                (amount_minor * 3000 / 10000), amount_minor - (amount_minor * 3000 / 10000), order_id, paid_at, paid_at
         FROM m_enroll`,
      );
      await q(
        `INSERT INTO payments (id, order_id, user_id, item_type, item_id, amount, discount_amount, final_amount,
                               amount_minor, currency, channel, provider, provider_reference, status, payment_method,
                               idempotency_key, created_at, completed_at)
         SELECT payment_id, order_id, student_id, 'package', package_id, amount_minor / 100.0, 0, amount_minor / 100.0,
                amount_minor, 'EGP', 'gateway', 'easykash', 'load-ref-' || replace(order_id::text, '-', ''),
                'completed', 'card', gen_random_uuid()::text, paid_at, paid_at
         FROM m_enroll`,
      );
      // orders.payment_id closes the order<->payment cycle; the settled-order revenue predicate
      // (common/metrics/product-financial-metrics.service.ts) needs it, plus paid_at and a completed payment.
      await q(
        `UPDATE orders o SET payment_id = e.payment_id FROM m_enroll e WHERE o.id = e.order_id`,
      );
      await q(
        `INSERT INTO entitlements (student_id, item_type, item_id, order_id, source_channel, granted_at, starts_at, status)
         SELECT student_id, 'package', package_id, order_id, 'gateway', paid_at, paid_at, 'active' FROM m_enroll`,
      );
      await q(
        `INSERT INTO package_purchases (payment_id, student_id, package_id, course_version_id, price_paid, purchased_at)
         SELECT e.payment_id, e.student_id, e.package_id, pk.current_version_id, e.amount_minor / 100.0, e.paid_at
         FROM m_enroll e JOIN lesson_packages pk ON pk.id = e.package_id`,
      );
      // One lesson_purchases row per lesson of the purchased version, as the real finalisation fans out. The real
      // flow expires access after lessons.available_for_days (default 7); a load run lasts hours, so expiry is
      // set 30-90 days ahead, otherwise every student would lose access mid-run and the learning journeys would
      // measure 403s. Documented deviation, see docs/performance/load-test-results.md.
      await q(
        `INSERT INTO lesson_purchases (payment_id, student_id, lesson_id, price_paid, access_granted_at, access_expires_at)
         SELECT e.payment_id, e.student_id, vi.lesson_id, 0, e.paid_at,
                now() + ((30 + abs(hashtext(e.order_id::text)) % 60) || ' days')::interval
         FROM m_enroll e
         JOIN lesson_packages pk ON pk.id = e.package_id
         JOIN course_version_items vi ON vi.version_id = pk.current_version_id
         ON CONFLICT DO NOTHING`,
      );
      await q(
        `INSERT INTO financial_ledger_entries (account, order_id, teacher_id, entry_type, amount_minor, currency, direction,
                                               source_channel, collection_party, status, reference, available_at, created_at)
         SELECT v.account, e.order_id, e.teacher_id, v.entry_type,
                CASE v.kind WHEN 'cash' THEN e.amount_minor
                            WHEN 'commission' THEN e.amount_minor * 3000 / 10000
                            ELSE e.amount_minor - e.amount_minor * 3000 / 10000 END,
                'EGP', v.direction, 'gateway', 'platform', 'posted',
                'order:' || e.order_id || ':' || v.kind, CASE v.kind WHEN 'earning' THEN e.paid_at END, e.paid_at
         FROM m_enroll e
         CROSS JOIN (VALUES ('cash', 'platform_cash', 'platform_collected_sale', 'debit'),
                            ('commission', 'platform_revenue', 'platform_commission', 'credit'),
                            ('earning', 'teacher_payable_available', 'teacher_earning_available', 'credit'))
                    AS v(kind, account, entry_type, direction)`,
      );
      // Watch sessions (written by POST /lessons/:id/enter|exit and PATCH /lessons/sessions/:id/progress; the admin dashboard's
      // activeLearners source): one per ~half of the purchased lessons, never in the future.
      await q(
        `INSERT INTO lesson_sessions (student_id, lesson_id, entered_at, exited_at, duration_seconds, video_progress_percent)
         SELECT s.student_id, s.lesson_id, s.entered_at, s.entered_at + (s.dur || ' seconds')::interval, s.dur, s.pct
         FROM (
           SELECT lp.student_id, lp.lesson_id,
                  LEAST(now() - interval '5 minutes',
                        e.paid_at + ((abs(hashtext(lp.id::text || 'e')) % 2400) || ' minutes')::interval) AS entered_at,
                  300 + abs(hashtext(lp.id::text || 'd')) % 1400 AS dur,
                  abs(hashtext(lp.id::text || 'p')) % 101 AS pct
           FROM lesson_purchases lp
           JOIN m_enroll e ON e.payment_id = lp.payment_id
           WHERE abs(hashtext(lp.id::text)) % 2 = 0
         ) s`,
      );
      // Progress on the first three lessons of a purchased package, for roughly 60% of enrollments.
      await q(
        `INSERT INTO lesson_progress (student_id, lesson_id, total_duration, last_watched_at)
         SELECT DISTINCT ON (e.student_id, i.lesson_id) e.student_id, i.lesson_id, 1800, e.paid_at + interval '1 day'
         FROM m_enroll e
         JOIN lesson_package_items i ON i.package_id = e.package_id AND i.order_index < 3
         WHERE abs(hashtext(e.order_id::text)) % 10 < 6
         ORDER BY e.student_id, i.lesson_id
         ON CONFLICT DO NOTHING`,
      );
      enrollments += (await db.query('SELECT count(*)::int AS c FROM m_enroll')).rows[0]
        .c as number;
    });
    log(`enrollments (order+payment+entitlement+purchase+ledger): ${enrollments}`);

    // ---- notifications, activity logs ---------------------------------------------------------------------------
    await inChunks(p.students, 5_000, async (lo, hi) => {
      await q(
        `INSERT INTO notifications (user_id, type, title, message, sent_at, is_read)
         SELECT s.id, (ARRAY['attendance','exam_result','purchase','lesson_expiring'])[1 + (k.n % 4)]::notifications_type_enum,
                'Load notification ' || k.n, 'Synthetic notification body for load testing.',
                now() - ((s.idx * 13 + k.n * 17) % 90 || ' days')::interval - ((k.n * 37) % 1440 || ' minutes')::interval,
                (abs(hashtext(s.id::text || k.n)) % 10) < 7
         FROM m_student s CROSS JOIN generate_series(1, $3::int) k(n)
         WHERE s.idx BETWEEN $1 AND $2`,
        [lo, hi, p.notificationsPerStudent],
      );
    });
    log(`notifications: ${p.students * p.notificationsPerStudent}`);

    await inChunks(p.activityLogs, 250_000, async (lo, hi) => {
      await q(
        `INSERT INTO activity_logs (user_id, action, resource_type, created_at)
         SELECT s.id, (ARRAY['login','view_lesson','start_exam','submit_exam','view_course'])[1 + (g.n % 5)],
                (ARRAY['session','lesson','exam','exam','package'])[1 + (g.n % 5)],
                now() - ((g.n * 7) % 180 || ' days')::interval - ((g.n * 11) % 1440 || ' minutes')::interval
         FROM generate_series($1::int, $2::int) g(n)
         JOIN m_student s ON s.idx = 1 + (g.n % $3::int)`,
        [lo, hi, p.students],
      );
    });
    log(`activity_logs: ${p.activityLogs}`);

    // The planner needs statistics, or every EXPLAIN and latency number is measured against defaults.
    log('ANALYZE');
    await q('ANALYZE');

    const counts = await db.query(
      `SELECT 'users' t, count(*) c FROM users UNION ALL SELECT 'lessons', count(*) FROM lessons
       UNION ALL SELECT 'lesson_packages', count(*) FROM lesson_packages UNION ALL SELECT 'orders', count(*) FROM orders
       UNION ALL SELECT 'entitlements', count(*) FROM entitlements UNION ALL SELECT 'ledger', count(*) FROM financial_ledger_entries
       UNION ALL SELECT 'package_purchases', count(*) FROM package_purchases
       UNION ALL SELECT 'lesson_purchases', count(*) FROM lesson_purchases UNION ALL SELECT 'lesson_sessions', count(*) FROM lesson_sessions
       UNION ALL SELECT 'lesson_progress', count(*) FROM lesson_progress UNION ALL SELECT 'notifications', count(*) FROM notifications
       UNION ALL SELECT 'activity_logs', count(*) FROM activity_logs`,
    );

    const dataDir = join(__dirname, '..', 'learnix-infra', 'loadtest', '.data');
    mkdirSync(dataDir, { recursive: true });
    const manifest = {
      profile: profileName,
      seededAt: new Date().toISOString(),
      password: PASSWORD,
      emailDomain: EMAIL_DOMAIN,
      accounts: {
        admin: { email: `admin1@${EMAIL_DOMAIN}` },
        callCenter: { prefix: 'callcenter', count: 3 },
        teachers: { prefix: 'teacher', count: p.teachers, whaleIndex: 1 },
        students: { prefix: 'student', count: p.students },
      },
      shape: { packagesPerTeacher: p.packagesPerTeacher, lessonsPerPackage: p.lessonsPerPackage },
      counts: Object.fromEntries(
        counts.rows.map((r: { t: string; c: string }) => [r.t, Number(r.c)]),
      ),
    };
    writeFileSync(join(dataDir, 'seed-manifest.json'), JSON.stringify(manifest, null, 2));
    log(`done. manifest: learnix-infra/loadtest/.data/seed-manifest.json`);
    console.table(manifest.counts);
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
