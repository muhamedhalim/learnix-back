/**
 * T212 (FR-331, SC-013). Seeds a large, correct-by-construction marketplace
 * catalogue — published courses with real version snapshots, real paid
 * orders and real active enrollments — so `load-marketplace-catalog.cjs`
 * has something realistic to hit. Bulk `INSERT ... SELECT` server-side
 * (Postgres-generated rows via `unnest()`), not one row per round trip —
 * the only way tens/hundreds of thousands of rows finish in a practical
 * window.
 *
 * SAFETY: refuses to run unless `DATABASE_URL`'s database name contains
 * "e2e", "test" or "load" (matching this repo's disposable e2e database
 * convention, `lms_e2e`) — the same "never touch a real deployment"
 * discipline `seed-staging.ts` enforces with its own guard, simplified for
 * a script that only ever needs to run against the throwaway database this
 * scale of synthetic data is meaningless anywhere else.
 *
 * USAGE
 *   npm run seed:marketplace-load                       # defaults: 200 courses, 1,000 enrollments (smoke scale)
 *   npm run seed:marketplace-load -- --courses=50000 --enrollments=500000   # full FR-331 target scale
 *   npm run seed:marketplace-load -- --reset             # truncate previously-seeded rows first
 *
 * THIS SCRIPT HAS BEEN RUN ONLY AT SMOKE SCALE (a few hundred courses) as
 * part of this task. The full 50,000/500,000-row execution has not been
 * run to completion — see tasks.md T212 for the recorded reason (practical
 * execution window) and what remains to actually run it.
 */
import { randomUUID } from 'node:crypto';

import { AppDataSource } from '../src/data-source';

interface Args {
  courses: number;
  enrollments: number;
  reset: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback: number): number => {
    const match = argv.find((a) => a.startsWith(`--${name}=`));
    return match ? Number(match.split('=')[1]) : fallback;
  };
  return {
    courses: get('courses', 200),
    enrollments: get('enrollments', 1000),
    reset: argv.includes('--reset'),
  };
}

function assertSafeTarget(databaseUrl: string | undefined): void {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.');
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL.');
  }
  const databaseName = url.pathname.replace(/^\//, '').toLowerCase();
  if (!/e2e|test|load/.test(databaseName)) {
    throw new Error(
      `Refusing to seed load-test data into database "${databaseName}" — its name doesn't look like a disposable test database (expected "e2e", "test" or "load" in the name). This script is only ever safe against the throwaway e2e database.`,
    );
  }
}

const CATEGORY_NAMES = ['Programming', 'Design', 'Business', 'Marketing', 'Data Science', 'Languages'];
const LEVELS = ['beginner', 'intermediate', 'advanced'];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertSafeTarget(process.env['DATABASE_URL']);

  console.log(`Seeding ${args.courses} courses / ${args.enrollments} enrollments against a disposable test database...`);
  await AppDataSource.initialize();
  const runner = AppDataSource.createQueryRunner();

  try {
    if (args.reset) {
      console.log('Truncating previously-seeded load rows...');
      await runner.query(`
        DELETE FROM marketplace_enrollments WHERE order_id IN (SELECT id FROM marketplace_orders WHERE order_number LIKE 'LOAD-%');
        DELETE FROM marketplace_orders WHERE order_number LIKE 'LOAD-%';
        DELETE FROM marketplace_course_versions WHERE course_id IN (SELECT id FROM marketplace_courses WHERE slug LIKE 'load-course-%');
        DELETE FROM marketplace_courses WHERE slug LIKE 'load-course-%';
        DELETE FROM marketplace_instructors WHERE slug LIKE 'load-instructor-%';
        DELETE FROM users WHERE email LIKE '%@load.learnix.invalid';
      `);
    }

    // --- Reference data: ensure the seeded EGP currency row exists (same as
    // the real migration + the e2e reset helper's re-seed) -----------------
    await runner.query(`
      INSERT INTO marketplace_currencies ("code", "minor_unit_exponent", "is_enabled", "min_price_minor", "max_price_minor", "min_payout_minor")
      VALUES ('EGP', 2, true, 5000, 2000000, 50000)
      ON CONFLICT ("code") DO NOTHING;
    `);

    // --- Categories ----------------------------------------------------
    const categoryIds = CATEGORY_NAMES.map(() => randomUUID());
    await runner.query(
      `INSERT INTO marketplace_categories (id, name_en, name_ar, slug, display_order)
       SELECT * FROM unnest($1::uuid[], $2::text[], $2::text[], $3::text[], $4::int[])
       ON CONFLICT (slug) DO NOTHING`,
      [
        categoryIds,
        CATEGORY_NAMES,
        CATEGORY_NAMES.map((n, i) => `load-${n.toLowerCase().replace(/\s+/g, '-')}-${i}`),
        CATEGORY_NAMES.map((_, i) => i),
      ],
    );

    // --- One admin (approved_by) — reuse an existing one, or create one --
    const [{ id: adminId }] = (await runner.query(
      `SELECT id FROM users WHERE role = 'admin' LIMIT 1`,
    )) as Array<{ id: string }>;
    let approvedBy = adminId as string | undefined;
    if (!approvedBy) {
      approvedBy = randomUUID();
      await runner.query(
        `INSERT INTO users (id, username, name, email, phone, role, status, is_active)
         VALUES ($1, 'load-admin', 'Load Admin', 'load-admin@load.learnix.invalid', '01000000000', 'admin', 'approved', true)`,
        [approvedBy],
      );
    }

    // --- Instructors: one per ~100 courses, batched -----------------------
    const instructorCount = Math.max(1, Math.ceil(args.courses / 100));
    const instructorIds: string[] = [];
    const BATCH = 2000;
    for (let start = 0; start < instructorCount; start += BATCH) {
      const count = Math.min(BATCH, instructorCount - start);
      const userIds = Array.from({ length: count }, () => randomUUID());
      const instrIds = Array.from({ length: count }, () => randomUUID());
      instructorIds.push(...instrIds);
      await runner.query(
        `INSERT INTO users (id, username, name, email, phone, role, status, is_active)
         SELECT * FROM unnest($1::uuid[], $2::text[], $2::text[], $3::text[], $4::text[], $5::text[], $5::text[], $6::bool[])`,
        [
          userIds,
          userIds.map((_, i) => `load-instructor-${start + i}-${Date.now()}`),
          userIds.map((_, i) => `load-instructor-${start + i}-${Date.now()}@load.learnix.invalid`),
          userIds.map((_, i) => `010${String(start + i).padStart(8, '0')}`),
          userIds.map(() => 'student'),
          userIds.map(() => true),
        ],
      );
      await runner.query(
        `INSERT INTO marketplace_instructors (id, user_id, status, slug, display_name, approved_by)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $4::text[], $5::uuid[])`,
        [
          instrIds,
          userIds,
          instrIds.map(() => 'approved'),
          instrIds.map((_, i) => `load-instructor-${start + i}`),
          instrIds.map(() => approvedBy),
        ],
      );
    }
    console.log(`Seeded ${instructorCount} instructors.`);

    // --- Courses + one published version each, batched --------------------
    let coursesSeeded = 0;
    for (let start = 0; start < args.courses; start += BATCH) {
      const count = Math.min(BATCH, args.courses - start);
      const courseIds = Array.from({ length: count }, () => randomUUID());
      const versionIds = Array.from({ length: count }, () => randomUUID());
      const titles = courseIds.map((_, i) => `Load Test Course ${start + i}`);
      const slugs = courseIds.map((_, i) => `load-course-${start + i}`);
      const instructorForCourse = courseIds.map((_, i) => instructorIds[(start + i) % instructorIds.length]!);
      const categoryForCourse = courseIds.map((_, i) => categoryIds[(start + i) % categoryIds.length]!);
      const levelForCourse = courseIds.map((_, i) => LEVELS[(start + i) % LEVELS.length]!);
      const priceForCourse = courseIds.map((_, i) => 50000 + ((start + i) % 30) * 5000);

      await runner.query(
        `INSERT INTO marketplace_courses
           (id, instructor_id, category_id, slug, title, summary, description, level, language,
            price_minor, currency, cover_image_key, certificate_enabled, status,
            total_duration_seconds, lesson_count, first_published_at, last_published_at)
         SELECT id, instructor_id, category_id, slug, title, summary, description, level, 'en',
                price_minor, 'EGP', 'covers/load.jpg', false, 'published',
                1800, 3, now(), now()
         FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $5::text[],
                      $5::text[], $6::text[], $7::bigint[]) AS t(id, instructor_id, category_id, slug, title, summary, description, level, price_minor)`,
        [courseIds, instructorForCourse, categoryForCourse, slugs, titles, levelForCourse, priceForCourse],
      );

      const snapshot = (title: string, priceMinor: number, categoryId: string) =>
        JSON.stringify({
          title,
          title_ar: null,
          summary: title,
          summary_ar: null,
          description: title,
          description_ar: null,
          category_id: categoryId,
          level: 'beginner',
          language: 'en',
          price_minor: priceMinor,
          currency: 'EGP',
          cover_image_key: 'covers/load.jpg',
          promo_video_id: null,
          learning_outcomes: [],
          prerequisites: [],
          target_audience: [],
          certificate_enabled: false,
          total_duration_seconds: 1800,
          lesson_count: 3,
          sections: [
            {
              id: randomUUID(),
              title: 'Getting Started',
              title_ar: null,
              position: 0,
              lessons: [0, 1, 2].map((i) => ({
                id: randomUUID(),
                title: `Lesson ${i + 1}`,
                title_ar: null,
                position: i,
                content_type: 'text',
                video_id: null,
                content_html: `<p>Content ${i + 1}</p>`,
                duration_seconds: 600,
                is_free_preview: i === 0,
                is_required_for_completion: true,
              })),
            },
          ],
        });

      await runner.query(
        `INSERT INTO marketplace_course_versions (id, course_id, version_number, snapshot, published_by)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::int[], $4::jsonb[], $5::uuid[])`,
        [
          versionIds,
          courseIds,
          courseIds.map(() => 1),
          courseIds.map((_, i) => snapshot(titles[i]!, priceForCourse[i]!, categoryForCourse[i]!)),
          courseIds.map(() => approvedBy),
        ],
      );

      await runner.query(
        `UPDATE marketplace_courses c SET current_version_id = v.id
         FROM unnest($1::uuid[], $2::uuid[]) AS v(course_id, id)
         WHERE c.id = v.course_id`,
        [courseIds, versionIds],
      );

      coursesSeeded += count;
      console.log(`  ...${coursesSeeded}/${args.courses} courses`);
    }

    // --- Learners + orders + enrollments, batched --------------------------
    const allCourseIds = (await runner.query(`SELECT id, instructor_id, current_version_id, price_minor FROM marketplace_courses WHERE slug LIKE 'load-course-%'`)) as Array<{
      id: string;
      instructor_id: string;
      current_version_id: string;
      price_minor: string;
    }>;

    let enrollmentsSeeded = 0;
    for (let start = 0; start < args.enrollments; start += BATCH) {
      const count = Math.min(BATCH, args.enrollments - start);
      const learnerIds = Array.from({ length: count }, () => randomUUID());
      const orderIds = Array.from({ length: count }, () => randomUUID());
      const enrollmentIds = Array.from({ length: count }, () => randomUUID());
      const coursesForEnrollment = Array.from({ length: count }, (_, i) => allCourseIds[(start + i) % allCourseIds.length]!);

      await runner.query(
        `INSERT INTO users (id, username, name, email, phone, role, status, is_active)
         SELECT * FROM unnest($1::uuid[], $2::text[], $2::text[], $3::text[], $4::text[], $5::text[], $5::text[], $6::bool[])`,
        [
          learnerIds,
          learnerIds.map((_, i) => `load-learner-${start + i}-${Date.now()}`),
          learnerIds.map((_, i) => `load-learner-${start + i}-${Date.now()}@load.learnix.invalid`),
          learnerIds.map((_, i) => `011${String(start + i).padStart(8, '0')}`),
          learnerIds.map(() => 'student'),
          learnerIds.map(() => true),
        ],
      );

      await runner.query(
        `INSERT INTO marketplace_orders
           (id, order_number, learner_id, course_id, course_version_id, instructor_id,
            gross_amount_minor, net_amount_minor, currency, commission_bps, commission_amount_minor,
            instructor_earning_minor, refund_window_days, consumption_cap_bps, status, is_zero_value,
            course_title_snapshot, instructor_name_snapshot, paid_at)
         SELECT id, order_number, learner_id, course_id, course_version_id, instructor_id,
                price_minor, price_minor, 'EGP', 3000, (price_minor * 0.3)::bigint,
                (price_minor * 0.7)::bigint, 14, 3000, 'paid', false,
                'Load Course', 'Load Instructor', now()
         FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[], $7::bigint[])
           AS t(id, order_number, learner_id, course_id, course_version_id, instructor_id, price_minor)`,
        [
          orderIds,
          orderIds.map((_, i) => `LOAD-${start + i}-${Date.now()}`),
          learnerIds,
          coursesForEnrollment.map((c) => c.id),
          coursesForEnrollment.map((c) => c.current_version_id),
          coursesForEnrollment.map((c) => c.instructor_id),
          coursesForEnrollment.map((c) => c.price_minor),
        ],
      );

      await runner.query(
        `INSERT INTO marketplace_enrollments (id, learner_id, course_id, course_version_id, order_id, status)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::text[])`,
        [enrollmentIds, learnerIds, coursesForEnrollment.map((c) => c.id), coursesForEnrollment.map((c) => c.current_version_id), orderIds, enrollmentIds.map(() => 'active')],
      );

      enrollmentsSeeded += count;
      console.log(`  ...${enrollmentsSeeded}/${args.enrollments} enrollments`);
    }

    console.log(`Done. Seeded ${coursesSeeded} courses and ${enrollmentsSeeded} enrollments.`);
  } finally {
    await runner.release();
    await AppDataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
