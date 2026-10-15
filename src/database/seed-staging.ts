/**
 * Synthetic staging seed.
 *
 * Builds a fully navigable platform out of invented data: administrators,
 * teachers, students, parents, courses, lessons, books, exams, attempts,
 * attendance, orders, payments, notifications and certificates.
 *
 * WHY SYNTHETIC RATHER THAN A PRODUCTION SNAPSHOT
 * -----------------------------------------------
 * A sanitised copy of production is only as good as its scrubbing pass, and it
 * puts real names, phone numbers and payment destinations on a non-production
 * host for the window between restore and scrub. This platform stores InstaPay
 * addresses and mobile-wallet numbers as ordinary database rows
 * (`payments/manual-payment-method-configuration.ts`), so a leaked snapshot
 * would publish real payment destinations to testers.
 *
 * Everything here is generated correct-by-construction instead:
 *
 *   - emails end in `@staging.learnix.invalid`. `.invalid` is reserved by
 *     RFC 2606 and can never resolve, so a misconfigured mailer physically
 *     cannot deliver to these addresses;
 *   - phone numbers occupy a fixed synthetic block;
 *   - payment identifiers are sandbox-shaped and reference no real provider
 *     transaction;
 *   - amounts, grades and attendance are invented, never derived.
 *
 * SAFETY
 * ------
 * Three independent guards run before a single row is written (see
 * `assertSafeTarget`). They are ordered cheapest-first and every one of them
 * aborts rather than warns.
 *
 * USAGE
 * -----
 *   npm run seed:staging            # create data
 *   npm run seed:staging -- --reset # truncate seeded tables, then create
 *
 * THIS SCRIPT HAS NOT BEEN RUN AGAINST ANY ENVIRONMENT. It is delivered in
 * Phase 0 and executed in Phase 7, after the staging database exists.
 */

import { randomUUID } from 'node:crypto';

import * as bcrypt from 'bcryptjs';
import { config as loadDotenv } from 'dotenv';
import { DataSource, type DeepPartial, type EntityManager } from 'typeorm';

import { AppEnvironment, recordReader, resolveAppEnv } from '../config/app-env';
import { typeOrmArtifactPaths } from '../data-source';
import { resolveDatabaseSsl } from '../common/utils/database-ssl.util';

import { AttendanceRecord } from '../attendance/entities/attendance-record.entity';
import { LessonSession } from '../attendance/entities/lesson-session.entity';
import { Book } from '../books/entities/book.entity';
import { Certificate } from '../certificates/entities/certificate.entity';
import { CertificateStatus } from '../certificates/entities/certificate-status.enum';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { AttemptState } from '../exams/entities/attempt-state.enum';
import { Exam } from '../exams/entities/exam.entity';
import { ExamStatus } from '../exams/entities/exam-status.enum';
import { DEFAULT_EXAM_CONFIG } from '../exams/entities/exam-config.interface';
import { Guardian } from '../guardians/entities/guardian.entity';
import { GuardianRelationship } from '../guardians/entities/guardian-relationship.enum';
import { GuardianVerificationStatus } from '../guardians/entities/guardian-verification-status.enum';
import { StudentGuardian } from '../guardians/entities/student-guardian.entity';
import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';
import { Lesson } from '../lessons/entities/lesson.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationType } from '../notifications/entities/notification-type.enum';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPackageItem } from '../packages/entities/lesson-package-item.entity';
import { Order } from '../payments/entities/order.entity';
import { OrderStatus } from '../payments/entities/order-status.enum';
import { Payment } from '../payments/entities/payment.entity';
import { PaymentChannel } from '../payments/entities/payment-channel.enum';
import { PaymentStatus } from '../payments/entities/payment-status.enum';
import { PaymentMethod } from '../payments/entities/payment-method.enum';
import { ItemType } from '../payments/entities/item-type.enum';
import { StudentProfile } from '../students/entities/student-profile.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { TeacherProfile } from '../teachers/entities/teacher-profile.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';

loadDotenv();

// ---------------------------------------------------------------------------
// Synthetic value conventions
// ---------------------------------------------------------------------------

/** RFC 2606 reserved TLD: mail to this domain can never be delivered. */
const EMAIL_DOMAIN = 'staging.learnix.invalid';

/** Fixed synthetic phone block. Not allocated to any real subscriber range. */
const PHONE_PREFIX = '+2010000';

/**
 * Shared password for every seeded account. Deliberately NOT a secret: these
 * accounts exist only on staging, hold only invented data, and their
 * credentials are handed to UAT testers. It is defined here rather than
 * generated so a tester can be told it out of band once.
 *
 * Overridable with `SEED_STAGING_PASSWORD` when a deployment prefers its own.
 */
const DEFAULT_PASSWORD = 'StagingTest!2026';

const COUNTS = {
  teachers: 3,
  students: 20,
  guardians: 10,
  callCenter: 2,
  subjects: 5,
  coursesPerTeacher: 3,
  lessonsPerCourse: 5,
  booksPerTeacher: 2,
  examsPerTeacher: 2,
} as const;

/** Tables this seed writes, in FK-safe deletion order (children first). */
const SEEDED_TABLES: readonly string[] = Object.freeze([
  'certificates',
  'notifications',
  'payments',
  'orders',
  'attendance_records',
  'lesson_sessions',
  'exam_attempts',
  'exams',
  'books',
  'lesson_package_items',
  'lesson_packages',
  'lessons',
  'student_guardians',
  'guardians',
  'student_profiles',
  'teacher_profiles',
  'subjects',
  'users',
]);

function pad(index: number): string {
  return String(index).padStart(2, '0');
}

function emailFor(role: string, index: number): string {
  return `${role}${pad(index)}@${EMAIL_DOMAIN}`;
}

function phoneFor(index: number): string {
  return `${PHONE_PREFIX}${String(index).padStart(4, '0')}`;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export class UnsafeSeedTargetError extends Error {
  public constructor(message: string) {
    super(
      `Refusing to seed: ${message}\n\n` +
        'This script writes fabricated users, orders and payments. It must only ever run ' +
        'against a disposable staging database.',
    );
    this.name = 'UnsafeSeedTargetError';
  }
}

export class SeedNotArmedError extends Error {
  public constructor() {
    super(
      'Refusing to seed: ALLOW_STAGING_SEED=true is required, even against a target that has ' +
        'already passed identity verification. This is a deliberate second, independent step — ' +
        'a correctly-identified staging database can still be mid-UAT with tester progress on ' +
        'it, and this script (especially its --reset path) must never run as a side effect of ' +
        'another command, a copy-pasted script, or muscle memory.',
    );
    this.name = 'SeedNotArmedError';
  }
}

/** Separated from `assertSafeTarget` on purpose: that function verifies WHERE
 * this is running; this verifies that running it at all was intended right
 * now. Exported so it is unit-testable without a database connection. */
export function assertSeedArmed(env: Record<string, string | undefined>): void {
  if (env['ALLOW_STAGING_SEED'] !== 'true') {
    throw new SeedNotArmedError();
  }
}

/** Hosts the seed must never write to. Extended by PROD_HOST_DENYLIST. */
const DEFAULT_FORBIDDEN_HOSTS: readonly string[] = Object.freeze([
  'learnix.school',
  'api.learnix.school',
  'learning-center-backend-production.up.railway.app',
]);

/** Database names that are production by convention. */
const DEFAULT_FORBIDDEN_DB_NAMES: readonly string[] = Object.freeze(['learnix', 'railway']);

const STAGING_DB_PATTERN = /(^|[^a-z])(staging|stg)([^a-z]|$)/i;

function parseList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(/[\s,]+/)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '');
}

/**
 * Three independent refusals, cheapest first.
 *
 * They are independent on purpose: an operator who has correctly set
 * APP_ENV=staging but pasted the wrong URL is stopped by guard 2, and one who
 * has the right server but the wrong database is stopped by guard 3.
 */
export function assertSafeTarget(
  env: Record<string, string | undefined>,
  databaseUrl: string | undefined,
): void {
  // Guard 1 — deployment identity.
  const appEnv = resolveAppEnv(recordReader(env as Record<string, unknown>));
  if (appEnv === AppEnvironment.Production) {
    throw new UnsafeSeedTargetError(
      'APP_ENV resolves to production (set APP_ENV=staging on the staging deployment).',
    );
  }

  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new UnsafeSeedTargetError('DATABASE_URL is not set.');
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new UnsafeSeedTargetError('DATABASE_URL is not a valid URL.');
  }

  const host = url.hostname.toLowerCase();
  const databaseName = url.pathname.replace(/^\//, '').toLowerCase();

  // Guard 2 — the server must not be a known production host.
  const forbiddenHosts = new Set([
    ...DEFAULT_FORBIDDEN_HOSTS,
    ...parseList(env['PROD_HOST_DENYLIST']),
    ...parseList(env['PROD_RESOURCE_DENYLIST']),
  ]);
  if (forbiddenHosts.has(host)) {
    throw new UnsafeSeedTargetError(`DATABASE_URL points at the production host "${host}".`);
  }

  // Guard 3 — the database must positively identify itself as staging.
  // Stated as a required shape rather than a denylist: a database that has not
  // been named for staging is treated as unknown, and unknown is not safe.
  const forbiddenNames = new Set([
    ...DEFAULT_FORBIDDEN_DB_NAMES,
    ...parseList(env['PROD_IDENTIFIER_DENYLIST']),
    ...parseList(env['PROD_RESOURCE_DENYLIST']),
  ]);
  if (forbiddenNames.has(databaseName)) {
    throw new UnsafeSeedTargetError(`database "${databaseName}" is a production database name.`);
  }
  if (!STAGING_DB_PATTERN.test(databaseName)) {
    throw new UnsafeSeedTargetError(
      `database "${databaseName}" does not identify itself as staging. Name it so it contains ` +
        '"staging" (or "stg"), e.g. "learnix_staging".',
    );
  }
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

interface SeedSummary {
  [table: string]: number;
}

async function seedUsers(
  manager: EntityManager,
  passwordHash: string,
): Promise<{
  admin: User;
  teachers: User[];
  students: User[];
  callCenter: User[];
}> {
  const users = manager.getRepository(User);

  function build(role: UserRole, index: number, label: string, prefix: number): User {
    return users.create({
      username: `${label}${pad(index)}`,
      name: `Test ${label[0]?.toUpperCase()}${label.slice(1)} ${pad(index)}`,
      first_name: `Test${pad(index)}`,
      last_name: label,
      email: emailFor(label, index),
      password_hash: passwordHash,
      phone: phoneFor(prefix + index),
      role,
      status: UserStatus.APPROVED,
      is_active: true,
      preferred_language: index % 2 === 0 ? PreferredLanguage.EN : PreferredLanguage.AR,
      finance_permissions: [],
    });
  }

  const admin = await users.save(build(UserRole.ADMIN, 1, 'admin', 0));

  const teachers: User[] = [];
  for (let index = 1; index <= COUNTS.teachers; index++) {
    teachers.push(await users.save(build(UserRole.TEACHER, index, 'teacher', 100)));
  }

  const students: User[] = [];
  for (let index = 1; index <= COUNTS.students; index++) {
    students.push(await users.save(build(UserRole.STUDENT, index, 'student', 200)));
  }

  const callCenter: User[] = [];
  for (let index = 1; index <= COUNTS.callCenter; index++) {
    callCenter.push(await users.save(build(UserRole.CALL_CENTER, index, 'callcenter', 300)));
  }

  return { admin, teachers, students, callCenter };
}

async function seedProfiles(
  manager: EntityManager,
  teachers: User[],
  students: User[],
): Promise<void> {
  const teacherProfiles = manager.getRepository(TeacherProfile);
  for (const [index, teacher] of teachers.entries()) {
    await teacherProfiles.save(
      teacherProfiles.create({
        user_id: teacher.id,
        qualifications: 'Synthetic staging qualification record',
        years_of_experience: 5 + index,
        bio: `Synthetic biography for ${teacher.name}.`,
        bio_ar: `سيرة اصطناعية لبيئة الاختبار.`,
        professional_title: 'Senior Instructor (staging)',
        specializations: ['staging-data'],
        languages: ['en', 'ar'],
        skills: ['teaching'],
        education: [],
        certificates: [],
      }),
    );
  }

  const studentProfiles = manager.getRepository(StudentProfile);
  for (const student of students) {
    await studentProfiles.save(
      studentProfiles.create({
        user_id: student.id,
        country: 'Egypt',
        governorate: 'Cairo',
        school: 'Staging Test School',
        is_public_profile: false,
        notification_settings: {},
      }),
    );
  }
}

async function seedGuardians(manager: EntityManager, students: User[]): Promise<number> {
  const guardians = manager.getRepository(Guardian);
  const links = manager.getRepository(StudentGuardian);
  let created = 0;

  for (let index = 1; index <= COUNTS.guardians; index++) {
    const guardian = await guardians.save(
      guardians.create({
        phone_e164: phoneFor(400 + index),
        full_name: `Test Parent ${pad(index)}`,
        preferred_language: PreferredLanguage.AR,
        // A spread of states so verification flows are testable end to end.
        verification_status:
          index % 3 === 0
            ? GuardianVerificationStatus.UNVERIFIED
            : GuardianVerificationStatus.VERIFIED,
        verified_at: index % 3 === 0 ? null : daysAgo(30),
        whatsapp_capable: index % 2 === 0,
        opted_out_at: null,
      }),
    );
    created++;

    const student = students[index - 1];
    if (student !== undefined) {
      await links.save(
        links.create({
          student_id: student.id,
          guardian_id: guardian.id,
          relationship: index % 2 === 0 ? GuardianRelationship.MOTHER : GuardianRelationship.FATHER,
          is_primary: true,
          receives_notifications: true,
        }),
      );
    }
  }

  return created;
}

async function seedCatalog(
  manager: EntityManager,
  teachers: User[],
): Promise<{ subjects: Subject[]; lessons: Lesson[]; packages: LessonPackage[]; books: Book[] }> {
  const subjectRepo = manager.getRepository(Subject);
  const subjects: Subject[] = [];
  const names = ['Mathematics', 'Physics', 'Chemistry', 'Biology', 'Arabic'];

  for (let index = 0; index < COUNTS.subjects; index++) {
    subjects.push(
      await subjectRepo.save(
        subjectRepo.create({
          name: `${names[index] ?? `Subject ${pad(index + 1)}`} (staging)`,
          description: 'Synthetic subject for staging.',
        }),
      ),
    );
  }

  const lessonRepo = manager.getRepository(Lesson);
  const packageRepo = manager.getRepository(LessonPackage);
  const itemRepo = manager.getRepository(LessonPackageItem);
  const bookRepo = manager.getRepository(Book);

  const lessons: Lesson[] = [];
  const packages: LessonPackage[] = [];
  const books: Book[] = [];

  for (const [teacherIndex, teacher] of teachers.entries()) {
    const subject = subjects[teacherIndex % subjects.length];
    if (subject === undefined) continue;

    for (let courseIndex = 1; courseIndex <= COUNTS.coursesPerTeacher; courseIndex++) {
      const courseLessons: Lesson[] = [];

      for (let lessonIndex = 1; lessonIndex <= COUNTS.lessonsPerCourse; lessonIndex++) {
        const lesson = await lessonRepo.save(
          lessonRepo.create({
            title: `Staging Lesson ${pad(courseIndex)}-${pad(lessonIndex)}`,
            description: 'Synthetic lesson content for staging.',
            teacher_id: teacher.id,
            subject_id: subject.id,
            // No video is attached: a video needs a real upload and transcode, and a
            // fabricated asset would surface as a broken player rather than as an
            // obvious gap.
            price: 50 + lessonIndex * 10,
            duration: 1800,
            available_for_days: 30,
            is_free_preview: lessonIndex === 1,
          }),
        );
        lessons.push(lesson);
        courseLessons.push(lesson);
      }

      // One draft, one scheduled, the rest published — so every lifecycle
      // branch (including the 5-minute auto-publish cron) has a subject.
      const isDraft = courseIndex === 1;
      const isScheduled = courseIndex === 2;

      const course = await packageRepo.save(
        packageRepo.create({
          title: `Staging Course ${pad(teacherIndex + 1)}-${pad(courseIndex)}`,
          title_ar: `دورة اصطناعية ${pad(courseIndex)}`,
          description: 'Synthetic course for staging validation.',
          description_ar: 'دورة اصطناعية لبيئة الاختبار.',
          teacher_id: teacher.id,
          subject_id: subject.id,
          price: 500 + courseIndex * 100,
          is_active: true,
          status: isDraft || isScheduled ? ('draft' as never) : ('published' as never),
          published_at: isDraft || isScheduled ? null : daysAgo(20),
          scheduled_publish_at: isScheduled ? new Date(Date.now() + 60 * 60 * 1000) : null,
        }),
      );
      packages.push(course);

      for (const [order, lesson] of courseLessons.entries()) {
        await itemRepo.save(
          itemRepo.create({
            package_id: course.id,
            lesson_id: lesson.id,
            order_index: order,
          }),
        );
      }
    }

    for (let bookIndex = 1; bookIndex <= COUNTS.booksPerTeacher; bookIndex++) {
      books.push(
        await bookRepo.save(
          bookRepo.create({
            title: `Staging Book ${pad(teacherIndex + 1)}-${pad(bookIndex)}`,
            title_ar: `كتاب اصطناعي ${pad(bookIndex)}`,
            description: 'Synthetic book for staging.',
            teacher_id: teacher.id,
            subject_id: subject.id,
            // Points at a staging-prefixed key that does not exist yet: paid
            // access control is what staging tests, and a missing object
            // produces an honest 404 rather than a fake success.
            book_file: `staging/books/synthetic-${pad(teacherIndex + 1)}-${pad(bookIndex)}.pdf`,
            price: bookIndex === 1 ? 0 : 120,
          }),
        ),
      );
    }
  }

  return { subjects, lessons, packages, books };
}

async function seedExams(
  manager: EntityManager,
  teachers: User[],
  subjects: Subject[],
  students: User[],
): Promise<{ exams: number; attempts: number }> {
  const examRepo = manager.getRepository(Exam);
  const attemptRepo = manager.getRepository(ExamAttempt);

  let exams = 0;
  let attempts = 0;

  for (const [teacherIndex, teacher] of teachers.entries()) {
    const subject = subjects[teacherIndex % subjects.length];
    if (subject === undefined) continue;

    for (let examIndex = 1; examIndex <= COUNTS.examsPerTeacher; examIndex++) {
      const exam = await examRepo.save(
        examRepo.create({
          teacher_id: teacher.id,
          subject_id: subject.id,
          title: `Staging Exam ${pad(teacherIndex + 1)}-${pad(examIndex)}`,
          title_ar: `اختبار اصطناعي ${pad(examIndex)}`,
          description: 'Synthetic exam for staging.',
          status: examIndex === 1 ? ExamStatus.PUBLISHED : ExamStatus.DRAFT,
          is_public: examIndex === 1,
          config: { ...DEFAULT_EXAM_CONFIG },
          total_marks: 100,
          passing_marks: 50,
        }),
      );
      exams++;

      if (examIndex !== 1) continue;

      // Attempts in several states so grading, review and auto-submit paths
      // all have data to act on.
      const states = [
        AttemptState.GRADED,
        AttemptState.SUBMITTED,
        AttemptState.IN_PROGRESS,
        AttemptState.EXPIRED,
      ];
      for (const [stateIndex, state] of states.entries()) {
        const student = students[(teacherIndex * states.length + stateIndex) % students.length];
        if (student === undefined) continue;

        // started_at/deadline_at are NOT NULL with no default (timing is
        // server-authoritative — see exam-attempt.entity.ts) and must be set
        // for every state, not only for the ones a caller happens to submit.
        // Caught by scripts/verify-seed-interconnection.ts, which failed with
        // a NOT NULL violation before this fix.
        const durationMs = DEFAULT_EXAM_CONFIG.duration_seconds * 1000;
        const startedAt = daysAgo(stateIndex + 1);
        const deadlineAt = new Date(startedAt.getTime() + durationMs);
        const submittedAt =
          state === AttemptState.SUBMITTED || state === AttemptState.GRADED
            ? new Date(startedAt.getTime() + durationMs / 2)
            : state === AttemptState.EXPIRED
              ? deadlineAt
              : null;
        const graded = state === AttemptState.GRADED;

        await attemptRepo.save(
          attemptRepo.create({
            exam_id: exam.id,
            student_id: student.id,
            attempt_number: 1,
            state,
            shuffle_seed: 1000 + stateIndex,
            started_at: startedAt,
            deadline_at: deadlineAt,
            submitted_at: submittedAt,
            // NOT NULL with no default (exam-attempt.entity.ts) — identifies
            // the client session, not a real one here.
            session_token: randomUUID(),
            auto_submitted: state === AttemptState.EXPIRED,
            graded_at: graded ? new Date(startedAt.getTime() + durationMs) : null,
            score_auto: graded ? 72 : null,
            score_manual: graded ? 8 : null,
            score_total: graded ? 80 : null,
            max_score: 100,
            passed: graded ? true : null,
          } as never),
        );
        attempts++;
      }
    }
  }

  return { exams, attempts };
}

async function seedAttendance(
  manager: EntityManager,
  students: User[],
  lessons: Lesson[],
): Promise<{ records: number; sessions: number }> {
  const recordRepo = manager.getRepository(AttendanceRecord);
  const sessionRepo = manager.getRepository(LessonSession);

  let records = 0;
  let sessions = 0;

  for (const [index, student] of students.entries()) {
    const lesson = lessons[index % lessons.length];
    if (lesson === undefined) continue;

    await recordRepo.save(
      recordRepo.create({
        student_id: student.id,
        lesson_id: lesson.id,
        status: index % 4 === 0 ? ('absent' as never) : ('present' as never),
        is_auto_marked: index % 2 === 0,
      } as never),
    );
    records++;

    await sessionRepo.save(
      sessionRepo.create({
        student_id: student.id,
        lesson_id: lesson.id,
        duration_seconds: 600 + index * 30,
        video_progress_percent: Math.min(100, index * 5),
      } as never),
    );
    sessions++;
  }

  return { records, sessions };
}

async function seedCommerce(
  manager: EntityManager,
  students: User[],
  packages: LessonPackage[],
): Promise<{ orders: number; payments: number }> {
  const orderRepo = manager.getRepository(Order);
  const paymentRepo = manager.getRepository(Payment);

  let orders = 0;
  let payments = 0;

  // A spread across every terminal and non-terminal state so reconciliation,
  // refund and reporting logic all have something to operate on.
  const plan: Array<{ order: OrderStatus; payment: PaymentStatus; channel: PaymentChannel }> = [
    { order: OrderStatus.PAID, payment: PaymentStatus.COMPLETED, channel: PaymentChannel.GATEWAY },
    {
      order: OrderStatus.AWAITING_PAYMENT,
      payment: PaymentStatus.PENDING,
      channel: PaymentChannel.GATEWAY,
    },
    { order: OrderStatus.REJECTED, payment: PaymentStatus.FAILED, channel: PaymentChannel.GATEWAY },
    {
      order: OrderStatus.REFUNDED,
      payment: PaymentStatus.REFUNDED,
      channel: PaymentChannel.GATEWAY,
    },
    {
      order: OrderStatus.UNDER_REVIEW,
      payment: PaymentStatus.PENDING,
      channel: PaymentChannel.MANUAL,
    },
    {
      order: OrderStatus.PAID,
      payment: PaymentStatus.COMPLETED,
      channel: PaymentChannel.ACTIVATION_CODE,
    },
  ];

  for (const [index, entry] of plan.entries()) {
    const student = students[index % students.length];
    const course = packages[index % packages.length];
    if (student === undefined || course === undefined) continue;

    const amountMinor = 50_000 + index * 1_000;
    // Matches DEFAULT_PLATFORM_COMMISSION_BPS in .env.example (30%). These
    // three columns are NOT NULL with no default (order.entity.ts) — omitting
    // them was caught by scripts/verify-seed-interconnection.ts.
    const platformCommissionBps = 3000;
    const platformCommissionMinor = Math.round((amountMinor * platformCommissionBps) / 10_000);
    const teacherEarningMinor = amountMinor - platformCommissionMinor;

    // Typed explicitly: passing a `never`-cast straight into `save()` makes
    // TypeScript resolve the array overload, so `order.id` would not exist.
    const orderEntity: Order = orderRepo.create({
      order_number: `STG-${pad(index + 1)}-${Date.now().toString().slice(-6)}`,
      student_id: student.id,
      teacher_id: course.teacher_id,
      item_type: ItemType.PACKAGE,
      item_id: course.id,
      quantity: 1,
      original_amount_minor: amountMinor,
      discount_amount_minor: 0,
      final_amount_minor: amountMinor,
      refunded_amount_minor: entry.order === OrderStatus.REFUNDED ? amountMinor : 0,
      currency: 'EGP',
      payment_channel: entry.channel,
      status: entry.order,
      product_title_snapshot: course.title,
      product_title_ar_snapshot: course.title_ar,
      platform_commission_bps: platformCommissionBps,
      platform_commission_minor: platformCommissionMinor,
      teacher_earning_minor: teacherEarningMinor,
    } as DeepPartial<Order>);
    const order = await orderRepo.save(orderEntity);
    orders++;

    await paymentRepo.save(
      paymentRepo.create({
        order_id: order.id,
        user_id: student.id,
        item_type: ItemType.PACKAGE,
        item_id: course.id,
        amount: amountMinor / 100,
        discount_amount: 0,
        final_amount: amountMinor / 100,
        amount_minor: amountMinor,
        currency: 'EGP',
        channel: entry.channel,
        provider: entry.channel === PaymentChannel.GATEWAY ? 'paymob' : null,
        // Sandbox-shaped references. These correspond to no real transaction
        // at any provider.
        provider_reference:
          entry.channel === PaymentChannel.GATEWAY ? `sandbox-ref-${pad(index + 1)}` : null,
        status: entry.payment,
        payment_method:
          entry.channel === PaymentChannel.ACTIVATION_CODE
            ? PaymentMethod.PURCHASE_CODE
            : entry.channel === PaymentChannel.MANUAL
              ? PaymentMethod.MANUAL
              : PaymentMethod.CARD,
        idempotency_key: randomUUID(),
      } as never),
    );
    payments++;
  }

  return { orders, payments };
}

async function seedNotifications(manager: EntityManager, students: User[]): Promise<number> {
  const repo = manager.getRepository(Notification);
  const types = [
    NotificationType.ATTENDANCE,
    NotificationType.EXAM_RESULT,
    NotificationType.PURCHASE,
    NotificationType.LESSON_EXPIRING,
  ];

  let created = 0;
  for (const [index, student] of students.slice(0, 8).entries()) {
    const type = types[index % types.length];
    if (type === undefined) continue;

    await repo.save(
      repo.create({
        user_id: student.id,
        type,
        title: `Staging notification ${pad(index + 1)}`,
        message: 'Synthetic notification generated by the staging seed.',
        is_read: index % 2 === 0,
        sent_at: daysAgo(index),
        read_at: index % 2 === 0 ? daysAgo(index) : null,
        sms_sent: false,
      } as never),
    );
    created++;
  }

  return created;
}

async function seedCertificates(
  manager: EntityManager,
  students: User[],
  packages: LessonPackage[],
  teachers: User[],
): Promise<number> {
  const repo = manager.getRepository(Certificate);
  let created = 0;

  for (let index = 0; index < 4; index++) {
    const student = students[index];
    const course = packages[index % packages.length];
    const teacher = teachers[index % teachers.length];
    if (student === undefined || course === undefined || teacher === undefined) continue;

    const revoked = index === 3;
    await repo.save(
      repo.create({
        certificate_number: `STG-CERT-${pad(index + 1)}`,
        verification_code: `STGVERIFY${pad(index + 1)}`,
        student_id: student.id,
        package_id: course.id,
        student_name: student.name,
        course_title: course.title,
        teacher_name: teacher.name,
        completion_percentage: 100,
        status: revoked ? CertificateStatus.REVOKED : CertificateStatus.ISSUED,
        is_public: !revoked,
        revoked_at: revoked ? daysAgo(2) : null,
        revoke_reason: revoked ? 'Synthetic revocation for staging testing.' : null,
        issued_at: daysAgo(10),
      } as never),
    );
    created++;
  }

  return created;
}

async function truncateSeededTables(dataSource: DataSource): Promise<void> {
  // RESTART IDENTITY CASCADE in one statement so FK order cannot bite, and so a
  // partially-seeded database from a failed run is fully cleared.
  const list = SEEDED_TABLES.map((table) => `"${table}"`).join(', ');
  await dataSource.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export class SeedAlreadyRanError extends Error {
  public constructor() {
    super(
      'Refusing to seed: this database already contains seeded accounts ' +
        `(a "@${EMAIL_DOMAIN}" user already exists). Running the seed again without --reset ` +
        'would create duplicate rows — every entity here is inserted fresh, none of it upserts. ' +
        'Re-run with `npm run seed:staging -- --reset` to truncate and reseed instead.',
    );
    this.name = 'SeedAlreadyRanError';
  }
}

/**
 * Idempotency guard: every seed function in this file INSERTs unconditionally
 * (none of them checks for or upserts over an existing row), so a second
 * plain `npm run seed:staging` against an already-seeded database would
 * duplicate every table rather than erroring cleanly or silently no-opting.
 * Detecting "already seeded" and refusing is deliberately chosen over making
 * every one of the nine seed functions individually idempotent
 * (`ON CONFLICT DO NOTHING` per entity): the seed is fixed, fabricated data
 * with no legitimate reason to grow on repeated runs, so "seed once, or
 * explicitly reset-and-reseed" is the correct operational contract, not
 * silent accumulation.
 */
async function hasExistingSeedData(dataSource: DataSource): Promise<boolean> {
  const rows = (await dataSource.query('SELECT 1 FROM users WHERE email LIKE $1 LIMIT 1', [
    `%@${EMAIL_DOMAIN}`,
  ])) as unknown[];
  return rows.length > 0;
}

export async function runStagingSeed(reset: boolean): Promise<SeedSummary> {
  const databaseUrl = process.env['DATABASE_URL'];
  assertSafeTarget(process.env, databaseUrl);
  assertSeedArmed(process.env);

  const artifacts = typeOrmArtifactPaths(__filename.endsWith('.js'));
  const dataSource = new DataSource({
    type: 'postgres',
    url: databaseUrl ?? '',
    entities: artifacts.entities,
    migrations: artifacts.migrations,
    synchronize: false,
    logging: ['error'],
    ssl: resolveDatabaseSsl(databaseUrl),
  });

  await dataSource.initialize();
  try {
    if (reset) {
      process.stdout.write('Resetting seeded tables...\n');
      await truncateSeededTables(dataSource);
    } else if (await hasExistingSeedData(dataSource)) {
      throw new SeedAlreadyRanError();
    }

    const passwordHash = await bcrypt.hash(
      process.env['SEED_STAGING_PASSWORD'] ?? DEFAULT_PASSWORD,
      10,
    );

    return await dataSource.transaction(async (manager) => {
      const { admin, teachers, students, callCenter } = await seedUsers(manager, passwordHash);
      await seedProfiles(manager, teachers, students);
      const guardianCount = await seedGuardians(manager, students);
      const { subjects, lessons, packages, books } = await seedCatalog(manager, teachers);
      const examCounts = await seedExams(manager, teachers, subjects, students);
      const attendanceCounts = await seedAttendance(manager, students, lessons);
      const commerceCounts = await seedCommerce(manager, students, packages);
      const notificationCount = await seedNotifications(manager, students);
      const certificateCount = await seedCertificates(manager, students, packages, teachers);

      return {
        admins: 1 + (admin ? 0 : 0),
        teachers: teachers.length,
        students: students.length,
        call_center: callCenter.length,
        guardians: guardianCount,
        subjects: subjects.length,
        lessons: lessons.length,
        courses: packages.length,
        books: books.length,
        exams: examCounts.exams,
        exam_attempts: examCounts.attempts,
        attendance_records: attendanceCounts.records,
        lesson_sessions: attendanceCounts.sessions,
        orders: commerceCounts.orders,
        payments: commerceCounts.payments,
        notifications: notificationCount,
        certificates: certificateCount,
      };
    });
  } finally {
    await dataSource.destroy();
  }
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');

  process.stdout.write('Synthetic staging seed\n');
  process.stdout.write(`  reset: ${String(reset)}\n\n`);

  const summary = await runStagingSeed(reset);

  for (const [key, count] of Object.entries(summary)) {
    process.stdout.write(`  ${key.padEnd(20)} ${String(count)}\n`);
  }
  process.stdout.write(
    `\nSeed complete. Accounts use the ${EMAIL_DOMAIN} domain and a shared staging password.\n`,
  );
}

// Only auto-run when invoked directly, so the guards can be unit-tested.
if (require.main === module) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  });
}
