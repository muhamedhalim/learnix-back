import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { DataSource } from 'typeorm';

import { Exam } from '../../src/exams/entities/exam.entity';
import { ExamAttempt } from '../../src/exams/entities/exam-attempt.entity';
import {
  Guardian,
  GuardianRelationship,
  GuardianVerificationStatus,
  PreferredLanguage,
  StudentGuardian,
} from '../../src/guardians/entities';
import { ParentEventType } from '../../src/common/events/parent-event-type.enum';
import { HomeworkSubmission } from '../../src/lessons/entities/homework-submission.entity';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { LessonHomework } from '../../src/lessons/entities/lesson-homework.entity';
import { Notification } from '../../src/notifications/entities';
import { MessageChannel } from '../../src/notifications/entities/message-channel.enum';
import { ParentMessage } from '../../src/notifications/entities/parent-message.entity';
import { ParentMessageStatus } from '../../src/notifications/entities/parent-message-status.enum';
import { CourseStatus } from '../../src/packages/entities/course-status.enum';
import { LessonPackage } from '../../src/packages/entities/lesson-package.entity';
import { LessonPackageItem } from '../../src/packages/entities/lesson-package-item.entity';
import {
  ItemType,
  LessonPurchase,
  PackagePurchase,
  Payment,
  PaymentChannel,
  PaymentMethod,
  PaymentStatus,
} from '../../src/payments/entities';
import { TeacherFollowUpService } from '../../src/teacher-follow-up/teacher-follow-up.service';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
  type E2EContext,
} from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

/**
 * T066 (W4-C2). The golden was captured from the implementation BEFORE the
 * ownership predicate became SQL (`UPDATE_FOLLOWUP_GOLDEN=1` on that code); the
 * rewritten service must reproduce it exactly for the roster, per-student detail,
 * timeline, guardians, parent-message list/stats/retry and the analytics summary,
 * on a fixture that carries every hidden filter of the ownership join: a revoked
 * purchase (still owned), a soft-deleted student, a soft-deleted lesson, a
 * soft-deleted package, a package whose only lesson is soft-deleted, a student of
 * a second teacher, a non-student role, and a student reached by BOTH a lesson and
 * a package (must not duplicate).
 */
const GOLDEN = path.join(__dirname, 'fixtures', 'teacher-follow-up-ownership.golden.json');

const UUID = new RegExp('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g');
const ISO = new RegExp('[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?Z', 'g');

describe('Teacher follow-up ownership (golden + authorization, postgres)', () => {
  let ctx: E2EContext;
  let counter: StatementCounter;
  let suiteStartedAt = 0;

  beforeAll(async () => {
    suiteStartedAt = Date.now();
    ctx = await createE2EApp();
    counter = new StatementCounter(ctx.dataSource);
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const ds = (): DataSource => ctx.dataSource;
  const at = (day: number, hour = 10): Date => new Date(Date.UTC(2026, 0, day, hour, 0, 0));
  let seq = 0;

  async function student(tag: string, role = UserRole.STUDENT, deleted = false): Promise<User> {
    seq += 1;
    const users = ds().getRepository(User);
    const saved = await users.save(
      users.create({
        username: `tfo-${tag}`,
        name: `Student ${tag}`,
        first_name: null,
        last_name: null,
        email: `tfo-${tag}@example.test`,
        phone: `0121${String(seq).padStart(7, '0')}`,
        role,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    if (deleted) await users.softDelete({ id: saved.id });
    return saved;
  }

  async function lesson(
    teacherId: string,
    subjectId: string,
    title: string,
    deleted = false,
  ): Promise<Lesson> {
    const lessons = ds().getRepository(Lesson);
    const saved = await lessons.save(
      lessons.create({
        title,
        description: null,
        teacher_id: teacherId,
        subject_id: subjectId,
        thumbnail: null,
        price: 0,
        duration: 600,
        is_group: true,
        available_for_days: 30,
        students_count: 0,
        is_free_preview: false,
      }),
    );
    if (deleted) await lessons.softDelete({ id: saved.id });
    return saved;
  }

  async function payment(userId: string, itemType: ItemType, itemId: string): Promise<Payment> {
    seq += 1;
    const payments = ds().getRepository(Payment);
    return payments.save(
      payments.create({
        order_id: null,
        user_id: userId,
        item_type: itemType,
        item_id: itemId,
        amount: 100,
        discount_amount: 0,
        final_amount: 100,
        amount_minor: 10_000,
        currency: 'EGP',
        channel: PaymentChannel.MANUAL,
        provider: null,
        provider_reference: `tfo-${String(seq)}`,
        status: PaymentStatus.COMPLETED,
        payment_method: PaymentMethod.MANUAL,
        provider_order_reference: null,
        provider_transaction_id: null,
        idempotency_key: `tfo-payment-${String(seq)}-${randomUUID()}`,
        failure_reason: null,
        completed_at: new Date(),
      }),
    );
  }

  async function buyLesson(
    studentId: string,
    lessonId: string,
    options: { revoked?: boolean } = {},
  ): Promise<void> {
    const pay = await payment(studentId, ItemType.LESSON, lessonId);
    const purchases = ds().getRepository(LessonPurchase);
    await purchases.save(
      purchases.create({
        student_id: studentId,
        lesson_id: lessonId,
        payment_id: pay.id,
        price_paid: 0,
        access_granted_at: at(1),
        access_expires_at:
          options.revoked === true ? at(2) : new Date(Date.now() + 30 * 86_400_000),
        days_extended: 0,
        revoked_at: options.revoked === true ? at(3) : null,
        revocation_reason: options.revoked === true ? 'refund' : null,
      }),
    );
  }

  async function buyPackage(studentId: string, packageId: string): Promise<void> {
    const pay = await payment(studentId, ItemType.PACKAGE, packageId);
    const purchases = ds().getRepository(PackagePurchase);
    await purchases.save(
      purchases.create({
        student_id: studentId,
        package_id: packageId,
        payment_id: pay.id,
        price_paid: 100,
        purchased_at: at(1),
        revoked_at: null,
        revocation_reason: null,
      }),
    );
  }

  async function makePackage(
    teacherId: string,
    subjectId: string,
    title: string,
    lessonIds: string[],
    deleted = false,
  ): Promise<LessonPackage> {
    const packages = ds().getRepository(LessonPackage);
    const saved = await packages.save(
      packages.create({
        title,
        title_ar: title,
        description: null,
        description_ar: null,
        teacher_id: teacherId,
        subject_id: subjectId,
        price: 100,
        original_price: null,
        is_active: true,
        thumbnail: null,
        status: CourseStatus.PUBLISHED,
        published_at: at(1),
      }),
    );
    const items = ds().getRepository(LessonPackageItem);
    await items.save(
      lessonIds.map((lessonId, index) =>
        items.create({ package_id: saved.id, lesson_id: lessonId, order_index: index }),
      ),
    );
    if (deleted) await packages.softDelete({ id: saved.id });
    return saved;
  }

  async function exam(teacherId: string, subjectId: string, title: string): Promise<Exam> {
    const exams = ds().getRepository(Exam);
    return exams.save(
      exams.create({
        teacher_id: teacherId,
        subject_id: subjectId,
        lesson_id: null,
        package_id: null,
        title,
        title_ar: title,
        description: null,
        description_ar: null,
        is_public: false,
        config: {},
        total_marks: 10,
        passing_marks: 5,
      } as never) as unknown as Exam,
    );
  }

  async function attempt(
    examId: string,
    studentId: string,
    options: { state: string; score: number | null; graded: Date | null; submit: Date },
  ): Promise<ExamAttempt> {
    const attempts = ds().getRepository(ExamAttempt);
    return attempts.save(
      attempts.create({
        exam_id: examId,
        student_id: studentId,
        attempt_number: 1,
        state: options.state as never,
        shuffle_seed: 0,
        started_at: new Date(options.submit.getTime() - 20 * 60_000),
        deadline_at: new Date(options.submit.getTime() + 60 * 60_000),
        submitted_at: options.state === 'in_progress' ? null : options.submit,
        auto_submitted: false,
        graded_at: options.graded,
        score_auto: options.score,
        score_manual: 0,
        score_total: options.score,
        max_score: 10,
        passed: options.score === null ? null : options.score >= 5,
        session_token: randomUUID(),
        idempotency_key: null,
        origin: 'online',
        created_at: options.submit,
        updated_at: options.submit,
      } as never) as unknown as ExamAttempt,
    );
  }

  async function attendance(
    studentId: string,
    lessonId: string,
    status: string,
    markedAt: Date,
  ): Promise<string> {
    const rows: { id: string }[] = await ds().query(
      `INSERT INTO attendance_records (student_id, lesson_id, status, marked_at)
       VALUES ($1, $2, $3, (CAST($4 AS timestamptz) AT TIME ZONE 'UTC')) RETURNING id`,
      [studentId, lessonId, status, markedAt.toISOString()],
    );
    return rows[0]!.id;
  }

  async function enteredLesson(
    studentId: string,
    lessonId: string,
    enteredAt: Date,
  ): Promise<void> {
    await ds().query(
      `INSERT INTO lesson_sessions (student_id, lesson_id, entered_at, duration_seconds)
       VALUES ($1, $2, (CAST($3 AS timestamptz) AT TIME ZONE 'UTC'), 60)`,
      [studentId, lessonId, enteredAt.toISOString()],
    );
  }

  async function guardian(
    studentId: string,
    tag: string,
    options: { primary?: boolean; verified?: boolean } = {},
  ): Promise<Guardian> {
    seq += 1;
    const guardians = ds().getRepository(Guardian);
    const saved = await guardians.save(
      guardians.create({
        phone_e164: `+2010${String(seq).padStart(8, '0')}`,
        full_name: `Guardian ${tag}`,
        preferred_language: PreferredLanguage.AR,
        verification_status:
          options.verified === false
            ? GuardianVerificationStatus.UNVERIFIED
            : GuardianVerificationStatus.VERIFIED,
        verified_at: options.verified === false ? null : at(1),
        whatsapp_capable: true,
        opted_out_at: null,
      }),
    );
    const links = ds().getRepository(StudentGuardian);
    await links.save(
      links.create({
        student_id: studentId,
        guardian_id: saved.id,
        relationship: GuardianRelationship.FATHER,
        is_primary: options.primary === true,
        receives_notifications: true,
        notification_preferences: {},
      }),
    );
    return saved;
  }

  async function message(
    studentId: string,
    guardianId: string,
    event: ParentEventType,
    subjectId: string,
    status: ParentMessageStatus,
    createdAt: Date,
  ): Promise<ParentMessage> {
    const messages = ds().getRepository(ParentMessage);
    const delivered =
      status === ParentMessageStatus.DELIVERED || status === ParentMessageStatus.READ;
    return messages.save(
      messages.create({
        idempotency_key: `${event}:${subjectId}:${guardianId}`,
        guardian_id: guardianId,
        student_id: studentId,
        event_type: event,
        channel: MessageChannel.WHATSAPP,
        status,
        template_key: 'tfo',
        body: `body ${status}`,
        variables: null,
        provider_message_id: null,
        attempts: 0,
        error_message: null,
        sent_at: delivered ? createdAt : null,
        delivered_at: delivered ? createdAt : null,
        read_at: status === ParentMessageStatus.READ ? createdAt : null,
        failed_at: status === ParentMessageStatus.FAILED ? createdAt : null,
        created_at: createdAt,
      } as never) as unknown as ParentMessage,
    );
  }

  interface Fixture {
    a: AuthenticatedUser;
    b: AuthenticatedUser;
    ids: Record<string, string>;
    labels: Map<string, string>;
  }

  async function seed(): Promise<Fixture> {
    const a = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
    const b = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
    const subjects = ds().getRepository(Subject);
    const subject = await subjects.save(
      subjects.create({
        name: 'TFO subject',
        description: null,
        description_ar: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );

    const la1 = await lesson(a.userId, subject.id, 'A lesson 1');
    const la2 = await lesson(a.userId, subject.id, 'A lesson 2');
    const lDeleted = await lesson(a.userId, subject.id, 'A deleted lesson', true);
    const lb1 = await lesson(b.userId, subject.id, 'B lesson 1');
    const pkg1 = await makePackage(a.userId, subject.id, 'A package (lesson 2)', [la2.id]);
    const pkgDeletedLessonOnly = await makePackage(
      a.userId,
      subject.id,
      'A package (deleted lesson)',
      [lDeleted.id],
    );
    const pkgDeleted = await makePackage(a.userId, subject.id, 'A deleted package', [la1.id], true);

    const s1 = await student('s1');
    const s2 = await student('s2');
    const s3 = await student('s3');
    const s4 = await student('s4');
    const s5 = await student('s5-deleted', UserRole.STUDENT, true);
    const s6 = await student('s6');
    const s7 = await student('s7');
    const s8 = await student('s8');
    const s9 = await student('s9');
    const s10 = await student('s10-notstudent', UserRole.CALL_CENTER);

    await buyLesson(s1.id, la1.id);
    await buyPackage(s2.id, pkg1.id);
    await buyLesson(s3.id, la1.id, { revoked: true });
    await buyLesson(s4.id, lb1.id);
    await buyLesson(s5.id, la1.id);
    await buyLesson(s6.id, lDeleted.id);
    await buyPackage(s7.id, pkgDeletedLessonOnly.id);
    await buyPackage(s8.id, pkgDeleted.id);
    await buyLesson(s9.id, la1.id);
    await buyPackage(s9.id, pkg1.id);
    await buyLesson(s10.id, la1.id);

    const ea = await exam(a.userId, subject.id, 'A exam');
    const eb = await exam(b.userId, subject.id, 'B exam');
    const attemptS1 = await attempt(ea.id, s1.id, {
      state: 'graded',
      score: 4,
      graded: at(6),
      submit: at(5),
    });
    const attemptS1Foreign = await attempt(eb.id, s1.id, {
      state: 'graded',
      score: 9,
      graded: at(6),
      submit: at(5, 12),
    });
    const attemptS2 = await attempt(ea.id, s2.id, {
      state: 'in_progress',
      score: null,
      graded: null,
      submit: at(7),
    });
    const attemptS4 = await attempt(eb.id, s4.id, {
      state: 'graded',
      score: 8,
      graded: at(6),
      submit: at(5),
    });

    const recS1 = await attendance(s1.id, la1.id, 'present', at(5));
    await attendance(s1.id, la2.id, 'absent', at(6));
    await attendance(s1.id, lDeleted.id, 'present', at(7));
    const recS2 = await attendance(s2.id, la2.id, 'late', at(6));
    await enteredLesson(s1.id, la1.id, at(5));
    await enteredLesson(s1.id, lb1.id, at(9));

    const homeworks = ds().getRepository(LessonHomework);
    const hw = await homeworks.save(
      homeworks.create({
        lesson_id: la1.id,
        title: 'A homework',
        title_ar: null,
        description: null,
        description_ar: null,
        type: 'text',
        resource_url: null,
        resource_filename: null,
        due_at: at(4),
        questions: [],
        max_score: 20,
        published_at: at(2),
      } as never) as unknown as LessonHomework,
    );
    await ds()
      .getRepository(HomeworkSubmission)
      .save(
        ds()
          .getRepository(HomeworkSubmission)
          .create({
            homework_id: hw.id,
            student_id: s1.id,
            answer_text: null,
            answers: [],
            resource_url: null,
            resource_filename: null,
            status: 'graded' as never,
            is_late: true,
            score: 15,
            feedback: null,
            submitted_at: at(5),
            graded_at: at(6),
            graded_by: null,
          } as never),
      );

    const g1 = await guardian(s1.id, 'g1-primary', { primary: true });
    const g2 = await guardian(s1.id, 'g2-secondary', { verified: false });
    const g3 = await guardian(s2.id, 'g3');
    const g4 = await guardian(s4.id, 'g4-other-teacher');

    const m1 = await message(
      s1.id,
      g1.id,
      ParentEventType.EXAM_GRADED,
      attemptS1.id,
      ParentMessageStatus.DELIVERED,
      at(6, 11),
    );
    const m2 = await message(
      s1.id,
      g1.id,
      ParentEventType.ATTENDANCE_MARKED,
      recS1,
      ParentMessageStatus.READ,
      at(6, 12),
    );
    const m3 = await message(
      s1.id,
      g1.id,
      ParentEventType.EXAM_GRADED,
      attemptS1Foreign.id,
      ParentMessageStatus.READ,
      at(6, 13),
    );
    const m4 = await message(
      s4.id,
      g4.id,
      ParentEventType.EXAM_GRADED,
      attemptS4.id,
      ParentMessageStatus.FAILED,
      at(6, 14),
    );
    const m5 = await message(
      s2.id,
      g3.id,
      ParentEventType.ATTENDANCE_MARKED,
      recS2,
      ParentMessageStatus.FAILED,
      at(6, 15),
    );

    // Created now, so the analytics "today" counter is exercised.
    const m6 = await message(
      s2.id,
      g3.id,
      ParentEventType.EXAM_GRADED,
      attemptS2.id,
      ParentMessageStatus.SENT,
      new Date(),
    );

    const ids: Record<string, string> = {
      teacherA: a.userId,
      teacherB: b.userId,
      s1: s1.id,
      s2: s2.id,
      s3: s3.id,
      s4: s4.id,
      s5: s5.id,
      s6: s6.id,
      s7: s7.id,
      s8: s8.id,
      s9: s9.id,
      s10: s10.id,
      la1: la1.id,
      la2: la2.id,
      lDeleted: lDeleted.id,
      lb1: lb1.id,
      pkg1: pkg1.id,
      examA: ea.id,
      examB: eb.id,
      attemptS1: attemptS1.id,
      attemptS1Foreign: attemptS1Foreign.id,
      attemptS2: attemptS2.id,
      attemptS4: attemptS4.id,
      recS1,
      recS2,
      hw: hw.id,
      g1: g1.id,
      g2: g2.id,
      g3: g3.id,
      g4: g4.id,
      m1: m1.id,
      m2: m2.id,
      m3: m3.id,
      m4: m4.id,
      m5: m5.id,
      m6: m6.id,
    };
    const labels = new Map(Object.entries(ids).map(([label, id]) => [id, label]));
    return { a, b, ids, labels };
  }

  /**
   * Replaces uuids by fixture labels and the fixture's own instants (the January 2026 dates built by
   * `at()`) by their rank. Instants generated by the run itself (row defaults, `new Date()`) differ on
   * every run and can share a millisecond, so ranking them made every later rank depend on machine
   * speed; they are all rendered as `now`. Their position in the response is still checked, because
   * array order is part of the golden.
   */
  function normalise(value: unknown, labels: Map<string, string>): unknown {
    const text = JSON.stringify(value);
    const isRunGenerated = (stamp: string): boolean =>
      Date.parse(stamp) >= suiteStartedAt - 86_400_000;
    const stamps = [...new Set(text.match(ISO) ?? [])].filter((s) => !isRunGenerated(s)).sort();
    const rank = new Map(
      stamps.map((stamp, index) => [stamp, `t${String(index).padStart(2, '0')}`]),
    );
    const replaced = text
      .replace(UUID, (id) => labels.get(id) ?? '<uuid>')
      .replace(ISO, (stamp) => (isRunGenerated(stamp) ? 'now' : (rank.get(stamp) ?? stamp)));
    return JSON.parse(replaced) as unknown;
  }

  const roster = (body: { data: { id: string }[] }, labels: Map<string, string>): string[] =>
    body.data.map((row) => labels.get(row.id) ?? row.id);

  it('keeps every owned-student output identical to the golden captured before the rewrite', async () => {
    const { a, b, ids, labels } = await seed();
    const followUp = ctx.app.get(TeacherFollowUpService);
    const get = async (agent: AuthenticatedUser, url: string) => {
      const res = await agent.agent.get(`${API_PREFIX}${url}`);
      return { status: res.status, body: res.body as unknown };
    };

    const actual: Record<string, unknown> = {
      rosterDefault: await get(a, '/teacher/students'),
      rosterSearch: await get(a, '/teacher/students?search=s1'),
      rosterSearchEmail: await get(a, '/teacher/students?search=TFO-S2'),
      rosterPage1: await get(a, '/teacher/students?limit=2&page=1'),
      rosterPage2: await get(a, '/teacher/students?limit=2&page=2'),
      rosterPage9: await get(a, '/teacher/students?limit=2&page=9'),
      detailS1: await get(a, `/teacher/students/${ids['s1']}`),
      detailS2: await get(a, `/teacher/students/${ids['s2']}`),
      detailS3Revoked: await get(a, `/teacher/students/${ids['s3']}`),
      detailS9Both: await get(a, `/teacher/students/${ids['s9']}`),
      detailS4Foreign: await get(a, `/teacher/students/${ids['s4']}`),
      detailS6DeletedLesson: await get(a, `/teacher/students/${ids['s6']}`),
      detailS7: await get(a, `/teacher/students/${ids['s7']}`),
      detailS8: await get(a, `/teacher/students/${ids['s8']}`),
      detailUnknown: await get(a, `/teacher/students/${randomUUID()}`),
      timelineS1: await get(a, `/teacher/students/${ids['s1']}/timeline`),
      timelineS2: await get(a, `/teacher/students/${ids['s2']}/timeline`),
      timelineS4Foreign: await get(a, `/teacher/students/${ids['s4']}/timeline`),
      guardiansS1: await get(a, `/teacher/students/${ids['s1']}/guardians`),
      guardiansS4Foreign: await get(a, `/teacher/students/${ids['s4']}/guardians`),
      messagesList: await get(a, '/teacher/parent-messages'),
      messagesListPaged: await get(a, '/teacher/parent-messages?limit=2&page=2'),
      messagesListFiltered: await get(a, `/teacher/parent-messages?student_id=${ids['s1']}`),
      messagesListForeignStudent: await get(a, `/teacher/parent-messages?student_id=${ids['s4']}`),
      messagesListStatus: await get(a, '/teacher/parent-messages?status=failed'),
      messagesStats: await get(a, '/teacher/parent-messages/stats'),
      analyticsSummary: await followUp.getAnalyticsSummary(ids['teacherA']!),
      teacherBRoster: await get(b, '/teacher/students'),
    };

    const normalised = normalise(actual, labels) as Record<string, unknown>;
    if (process.env['UPDATE_FOLLOWUP_GOLDEN'] === '1') {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, `${JSON.stringify(normalised, null, 2)}\n`);
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
    expect(normalised).toEqual(golden);
  });

  it('denies every per-student route for a student owned only by another teacher', async () => {
    const { a, b, ids } = await seed();
    const notificationsBefore = await ds().getRepository(Notification).count();
    const forbidden = {
      statusCode: 403,
      message: 'You can only access your own students',
    };
    for (const url of [
      `/teacher/students/${ids['s4']}`,
      `/teacher/students/${ids['s4']}/timeline`,
      `/teacher/students/${ids['s4']}/guardians`,
    ]) {
      const res = await a.agent.get(`${API_PREFIX}${url}`);
      expect({ url, status: res.status }).toEqual({ url, status: 403 });
      expect(JSON.stringify(res.body)).toContain(forbidden.message);
    }
    const message = await a.agent
      .post(`${API_PREFIX}/teacher/students/${ids['s4']}/message`)
      .send({ message: 'hello' });
    expect(message.status).toBe(403);
    expect(JSON.stringify(message.body)).toContain(forbidden.message);
    await expect(ds().getRepository(Notification).count()).resolves.toBe(notificationsBefore);

    // Resending an OTP for a foreign student's guardian is refused too.
    const otp = await a.agent.post(
      `${API_PREFIX}/teacher/students/${ids['s4']}/guardians/${ids['g4']}/resend-otp`,
    );
    expect(otp.status).toBe(403);

    // Parent messages: list/stats exclude S4 and retry of S4's message is a 404.
    const list = await a.agent.get(`${API_PREFIX}/teacher/parent-messages`);
    const listed = (list.body as { data: { id: string }[] }).data.map((row) => row.id);
    expect(listed).not.toContain(ids['m4']);
    expect(listed.sort()).toEqual([ids['m1'], ids['m2'], ids['m3'], ids['m5'], ids['m6']].sort());
    const retry = await a.agent.post(`${API_PREFIX}/teacher/parent-messages/${ids['m4']}/retry`);
    expect(retry.status).toBe(404);
    const missing = await a.agent.post(
      `${API_PREFIX}/teacher/parent-messages/${randomUUID()}/retry`,
    );
    expect(missing.status).toBe(404);
    // "Not yours" and "does not exist" are indistinguishable.
    const shape = (body: Record<string, unknown>) => [
      body['status'],
      body['title'],
      body['detail'],
    ];
    expect(shape(retry.body as Record<string, unknown>)).toEqual(
      shape(missing.body as Record<string, unknown>),
    );

    // Teacher B sees S4 (and only their own) and is denied A's students.
    const bRoster = await b.agent.get(`${API_PREFIX}/teacher/students`);
    expect(
      roster(
        bRoster.body as { data: { id: string }[] },
        new Map(Object.entries(ids).map(([k, v]) => [v, k])),
      ),
    ).toEqual(['s4']);
    const bDenied = await b.agent.get(`${API_PREFIX}/teacher/students/${ids['s1']}`);
    expect(bDenied.status).toBe(403);
  });

  it('owns revoked purchases and package students, hides deleted students/lessons/packages', async () => {
    const { a, labels } = await seed();
    const res = await a.agent.get(`${API_PREFIX}/teacher/students?limit=100`);
    const names = roster(res.body as { data: { id: string }[] }, labels);
    // Owned: direct (s1), package (s2, s9 once), revoked (s3). Not owned / not listed:
    // s4 (other teacher), s5 (soft-deleted user), s6 (soft-deleted lesson), s7 (package of a
    // deleted lesson), s8 (soft-deleted package), s10 (not a student role).
    expect(names.sort()).toEqual(['s1', 's2', 's3', 's9']);
    expect((res.body as { meta: { total: number } }).meta.total).toBe(4);
  });

  it('issues the documented number of statements per request', async () => {
    const { a, ids } = await seed();
    const followUp = ctx.app.get(TeacherFollowUpService);
    const handlerStatements = async (requestId: string, url: string): Promise<number> => {
      counter.start();
      await a.agent.get(`${API_PREFIX}${url}`).set('X-Request-Id', requestId).expect(200);
      counter.stop();
      return counter
        .statements({ requestId })
        .filter((statement) => !statement.sql.includes('"session"."id"')).length;
    };
    const counts = {
      roster: await handlerStatements('tfo-roster', '/teacher/students'),
      detail: await handlerStatements('tfo-detail', `/teacher/students/${ids['s1']}`),
      guardians: await handlerStatements(
        'tfo-guardians',
        `/teacher/students/${ids['s1']}/guardians`,
      ),
      timeline: await handlerStatements('tfo-timeline', `/teacher/students/${ids['s1']}/timeline`),
      messagesList: await handlerStatements('tfo-list', '/teacher/parent-messages'),
      messagesStats: await handlerStatements('tfo-stats', '/teacher/parent-messages/stats'),
    };
    counter.start();
    await followUp.getAnalyticsSummary(ids['teacherA']!);
    counter.stop();
    const analytics = counter.count();

    // Before T066: roster 10, detail 10, guardians 4, timeline 8, parent list 4, stats 3,
    // analytics 12 (cache miss), all with ownership materialised as an id array. T066 took analytics to 10;
    // T077 replaces the per-record risk reads with one aggregate statement: 4 (guardians, today, stats, risk).
    expect({ ...counts, analytics }).toEqual({
      roster: 7,
      detail: 8,
      guardians: 3,
      timeline: 5,
      messagesList: 2,
      messagesStats: 1,
      analytics: 4,
    });

    // Bind-ceiling guard: no statement on the follow-up paths expands an id list into one bind
    // per id ("IN ($1, $2, ...)"); lists travel as a single array bind ("= ANY($n)").
    // (the fixture owns 4 students; the two constant event types are not an id list)
    const spread = new RegExp(String.raw`IN \(\$[0-9]+, \$[0-9]+, \$`);
    const sqlOfAnalytics = counter.statements().map((statement) => statement.sql);
    expect(sqlOfAnalytics.length).toBe(4);
    expect(sqlOfAnalytics.filter((sql) => spread.test(sql))).toEqual([]);
    // T077: the analytics path no longer carries an id list at all (ownership is a subquery and the risk
    // figures are one aggregate statement), so the positive evidence is that statement, not an ANY bind.
    expect(sqlOfAnalytics.filter((sql) => sql.includes('WITH live AS'))).toHaveLength(1);
  });
});
