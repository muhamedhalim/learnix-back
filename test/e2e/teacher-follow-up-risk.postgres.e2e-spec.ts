import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { ParentEventType } from '../../src/common/events/parent-event-type.enum';
import { Exam } from '../../src/exams/entities/exam.entity';
import { ExamAttempt } from '../../src/exams/entities/exam-attempt.entity';
import {
  Guardian,
  GuardianRelationship,
  GuardianVerificationStatus,
  PreferredLanguage,
  StudentGuardian,
} from '../../src/guardians/entities';
import { HomeworkSubmission } from '../../src/lessons/entities/homework-submission.entity';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { LessonHomework } from '../../src/lessons/entities/lesson-homework.entity';
import { MessageChannel } from '../../src/notifications/entities/message-channel.enum';
import { ParentMessage } from '../../src/notifications/entities/parent-message.entity';
import { ParentMessageStatus } from '../../src/notifications/entities/parent-message-status.enum';
import {
  ItemType,
  LessonPurchase,
  Payment,
  PaymentChannel,
  PaymentMethod,
  PaymentStatus,
} from '../../src/payments/entities';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { TeacherFollowUpService } from '../../src/teacher-follow-up/teacher-follow-up.service';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

jest.setTimeout(180_000);

/**
 * T077 (W3-C5, after W4-C2). `riskStudentCount` from the one aggregate statement must equal the
 * count derived from the unchanged per-record path (`buildSummaries` + `assessRisk`), and every
 * item of the T076 equality checklist (gates/W4-C2-risk-sql.md, E1-E20) has a scenario here. Each
 * scenario owns an isolated teacher and a single student, so a mismatch cannot hide behind another
 * student's opposite mismatch. The `expected` value documents the intended outcome; the old-path
 * value is the parity oracle.
 */
describe('Teacher follow-up risk count: SQL aggregate parity (postgres)', () => {
  let ctx: E2EContext;
  let followUp: TeacherFollowUpService;
  let counter: StatementCounter;
  let subjectId: string | null = null;

  beforeAll(async () => {
    ctx = await createE2EApp();
    followUp = ctx.app.get(TeacherFollowUpService);
    counter = new StatementCounter(ctx.dataSource);
  });
  beforeEach(async () => {
    subjectId = null;
    await resetDatabase(ctx.dataSource);
  });
  afterAll(async () => ctx.app.close());

  const ds = (): DataSource => ctx.dataSource;
  const DAY = 86_400_000;
  const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY);
  let seq = 0;

  async function user(tag: string, role = UserRole.STUDENT, deleted = false): Promise<User> {
    seq += 1;
    const users = ds().getRepository(User);
    const saved = await users.save(
      users.create({
        username: `risk-${tag}-${String(seq)}`,
        name: `Risk ${tag}`,
        first_name: null,
        last_name: null,
        email: `risk-${tag}-${String(seq)}@example.test`,
        phone: `0122${String(seq).padStart(7, '0')}`,
        role,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    if (deleted) await users.softDelete({ id: saved.id });
    return saved;
  }

  async function subject(): Promise<string> {
    if (subjectId !== null) return subjectId;
    const repo = ds().getRepository(Subject);
    const saved = await repo.save(
      repo.create({
        name: 'Risk subject',
        description: null,
        description_ar: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
    subjectId = saved.id;
    return saved.id;
  }

  async function lesson(teacherId: string, deleted = false): Promise<Lesson> {
    const repo = ds().getRepository(Lesson);
    const saved = await repo.save(
      repo.create({
        title: `Lesson ${String((seq += 1))}`,
        description: null,
        teacher_id: teacherId,
        subject_id: await subject(),
        thumbnail: null,
        price: 0,
        duration: 600,
        is_group: true,
        available_for_days: 30,
        students_count: 0,
        is_free_preview: false,
      }),
    );
    if (deleted) await repo.softDelete({ id: saved.id });
    return saved;
  }

  async function buy(studentId: string, lessonId: string): Promise<void> {
    seq += 1;
    const payments = ds().getRepository(Payment);
    const pay = await payments.save(
      payments.create({
        order_id: null,
        user_id: studentId,
        item_type: ItemType.LESSON,
        item_id: lessonId,
        amount: 100,
        discount_amount: 0,
        final_amount: 100,
        amount_minor: 10_000,
        currency: 'EGP',
        channel: PaymentChannel.MANUAL,
        provider: null,
        provider_reference: `risk-${String(seq)}`,
        status: PaymentStatus.COMPLETED,
        payment_method: PaymentMethod.MANUAL,
        provider_order_reference: null,
        provider_transaction_id: null,
        idempotency_key: `risk-pay-${String(seq)}-${randomUUID()}`,
        failure_reason: null,
        completed_at: new Date(),
      }),
    );
    const purchases = ds().getRepository(LessonPurchase);
    await purchases.save(
      purchases.create({
        student_id: studentId,
        lesson_id: lessonId,
        payment_id: pay.id,
        price_paid: 0,
        access_granted_at: daysAgo(40),
        access_expires_at: new Date(Date.now() + 30 * DAY),
        days_extended: 0,
        revoked_at: null,
        revocation_reason: null,
      }),
    );
  }

  async function exam(teacherId: string, deleted = false): Promise<Exam> {
    const repo = ds().getRepository(Exam);
    const saved = await repo.save(
      repo.create({
        teacher_id: teacherId,
        subject_id: await subject(),
        lesson_id: null,
        package_id: null,
        title: 'Risk exam',
        title_ar: 'Risk exam',
        description: null,
        description_ar: null,
        is_public: false,
        config: {},
        total_marks: 100,
        passing_marks: 50,
      } as never) as unknown as Exam,
    );
    if (deleted) await repo.softDelete({ id: saved.id });
    return saved;
  }

  async function attempt(
    examId: string,
    studentId: string,
    options: { score: number | null; max?: number; state?: string; graded?: boolean },
  ): Promise<ExamAttempt> {
    seq += 1;
    const state = options.state ?? 'graded';
    const gradedAt = options.graded === false || state !== 'graded' ? null : daysAgo(3);
    const submit = daysAgo(4);
    const repo = ds().getRepository(ExamAttempt);
    return repo.save(
      repo.create({
        exam_id: examId,
        student_id: studentId,
        attempt_number: seq,
        state: state as never,
        shuffle_seed: 0,
        started_at: new Date(submit.getTime() - 20 * 60_000),
        deadline_at: new Date(submit.getTime() + 60 * 60_000),
        submitted_at: state === 'in_progress' ? null : submit,
        auto_submitted: false,
        graded_at: gradedAt,
        score_auto: options.score,
        score_manual: 0,
        score_total: options.score,
        max_score: options.max ?? 100,
        passed: null,
        session_token: randomUUID(),
        idempotency_key: null,
        origin: 'online',
        created_at: submit,
        updated_at: submit,
      } as never) as unknown as ExamAttempt,
    );
  }

  async function attendance(studentId: string, lessonId: string, status: string): Promise<string> {
    const rows: { id: string }[] = await ds().query(
      `INSERT INTO attendance_records (student_id, lesson_id, status, marked_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '2 days') RETURNING id`,
      [studentId, lessonId, status],
    );
    return rows[0]!.id;
  }

  async function session(studentId: string, lessonId: string, ago: number): Promise<void> {
    await ds().query(
      `INSERT INTO lesson_sessions (student_id, lesson_id, entered_at, duration_seconds)
       VALUES ($1, $2, $3, 60)`,
      [studentId, lessonId, daysAgo(ago)],
    );
  }

  async function guardian(
    studentId: string,
    options: {
      primary?: boolean;
      verified?: boolean;
      optedOut?: boolean;
      deleted?: boolean;
      createdAt?: Date;
    } = {},
  ): Promise<{ guardian: Guardian; linkId: string }> {
    seq += 1;
    const guardians = ds().getRepository(Guardian);
    const saved = await guardians.save(
      guardians.create({
        phone_e164: `+2011${String(seq).padStart(8, '0')}`,
        full_name: `Guardian ${String(seq)}`,
        preferred_language: PreferredLanguage.AR,
        verification_status:
          options.verified === false
            ? GuardianVerificationStatus.UNVERIFIED
            : GuardianVerificationStatus.VERIFIED,
        verified_at: options.verified === false ? null : daysAgo(30),
        whatsapp_capable: true,
        opted_out_at: options.optedOut === true ? daysAgo(1) : null,
      }),
    );
    if (options.deleted === true) await guardians.softDelete({ id: saved.id });
    const links = ds().getRepository(StudentGuardian);
    const link = await links.save(
      links.create({
        student_id: studentId,
        guardian_id: saved.id,
        relationship: GuardianRelationship.FATHER,
        is_primary: options.primary === true,
        receives_notifications: true,
        notification_preferences: {},
      }),
    );
    if (options.createdAt) {
      await ds().query('UPDATE student_guardians SET created_at = $1 WHERE id = $2', [
        options.createdAt,
        link.id,
      ]);
    }
    return { guardian: saved, linkId: link.id };
  }

  async function message(
    studentId: string,
    guardianId: string,
    event: ParentEventType,
    subjectRecordId: string,
    status: ParentMessageStatus,
  ): Promise<void> {
    const repo = ds().getRepository(ParentMessage);
    const delivered =
      status === ParentMessageStatus.DELIVERED || status === ParentMessageStatus.READ;
    await repo.save(
      repo.create({
        idempotency_key: `${event}:${subjectRecordId}:${guardianId}:${randomUUID()}`.slice(0, 200),
        guardian_id: guardianId,
        student_id: studentId,
        event_type: event,
        channel: MessageChannel.WHATSAPP,
        status,
        template_key: 'risk',
        body: 'body',
        variables: null,
        provider_message_id: null,
        attempts: 0,
        error_message: null,
        sent_at: delivered ? daysAgo(2) : null,
        delivered_at: delivered ? daysAgo(2) : null,
        read_at: status === ParentMessageStatus.READ ? daysAgo(1) : null,
        failed_at: null,
        created_at: daysAgo(2),
      } as never) as unknown as ParentMessage,
    );
  }

  async function homework(
    lessonId: string,
    studentId: string,
    options: { submitted: boolean; late?: boolean; publishedHomeworks?: number },
  ): Promise<void> {
    const repo = ds().getRepository(LessonHomework);
    const hw = await repo.save(
      repo.create({
        lesson_id: lessonId,
        title: 'Risk homework',
        title_ar: null,
        description: null,
        description_ar: null,
        type: 'text',
        resource_url: null,
        resource_filename: null,
        due_at: daysAgo(5),
        questions: [],
        max_score: 20,
        published_at: daysAgo(10),
      } as never) as unknown as LessonHomework,
    );
    if (!options.submitted) return;
    const subs = ds().getRepository(HomeworkSubmission);
    await subs.save(
      subs.create({
        homework_id: hw.id,
        student_id: studentId,
        answer_text: null,
        answers: [],
        resource_url: null,
        resource_filename: null,
        status: 'graded' as never,
        is_late: options.late === true,
        score: 15,
        feedback: null,
        submitted_at: daysAgo(4),
        graded_at: daysAgo(3),
        graded_by: null,
      } as never),
    );
  }

  interface Scenario {
    teacher: User;
    student: User;
    ownLesson: Lesson;
  }

  /** A teacher with one lesson and one student who has bought it and has a verified, primary guardian: risk "low". */
  async function clean(options: { guardian?: boolean } = {}): Promise<Scenario> {
    const teacher = await user('teacher', UserRole.TEACHER);
    const student = await user('student');
    const ownLesson = await lesson(teacher.id);
    await buy(student.id, ownLesson.id);
    if (options.guardian !== false) await guardian(student.id, { primary: true });
    return { teacher, student, ownLesson };
  }

  /** The unchanged per-record path: every owned user through `buildSummaries`, counted as the old code did. */
  async function oldCount(teacherId: string): Promise<number> {
    const service = followUp as unknown as {
      ownedStudentIdsSubQuery(id: string): { sql: string; params: Record<string, string> };
      buildSummaries(
        id: string,
        students: User[],
      ): Promise<Map<string, { risk: { level: string } }>>;
    };
    const owned = service.ownedStudentIdsSubQuery(teacherId);
    const students = await ds()
      .getRepository(User)
      .createQueryBuilder('u')
      .where(`u.id IN (${owned.sql})`, owned.params)
      .getMany();
    const summaries = await service.buildSummaries(teacherId, students);
    return [...summaries.values()].filter((summary) => summary.risk.level !== 'low').length;
  }

  async function check(teacherId: string, expected?: number): Promise<number> {
    const old = await oldCount(teacherId);
    const next = (await followUp.getAnalyticsSummary(teacherId)).riskStudentCount;
    expect(next).toBe(old);
    if (expected !== undefined) expect(old).toBe(expected);
    return next;
  }

  it('baseline: a verified-guardian student with no activity is not at risk', async () => {
    const { teacher } = await clean();
    await check(teacher.id, 0);
  });

  describe('exam average (E3-E7)', () => {
    it('low graded average fires; a healthy one does not', async () => {
      const low = await clean();
      const e1 = await exam(low.teacher.id);
      await attempt(e1.id, low.student.id, { score: 50 });
      await check(low.teacher.id, 1);

      const ok = await clean();
      const e2 = await exam(ok.teacher.id);
      await attempt(e2.id, ok.student.id, { score: 80 });
      await check(ok.teacher.id, 0);
    });

    it('only graded attempts with graded_at count; a low submitted or in-progress attempt does not', async () => {
      const s = await clean();
      const e = await exam(s.teacher.id);
      await attempt(e.id, s.student.id, { score: 10, state: 'submitted' });
      await attempt(e.id, s.student.id, { score: 10, state: 'in_progress' });
      await attempt(e.id, s.student.id, { score: 10, graded: false });
      await check(s.teacher.id, 0);
    });

    it('a graded attempt on a soft-deleted exam is ignored', async () => {
      const s = await clean();
      const e = await exam(s.teacher.id, true);
      await attempt(e.id, s.student.id, { score: 10 });
      await check(s.teacher.id, 0);
    });

    it("another teacher's graded exam never counts against this teacher's student", async () => {
      const s = await clean();
      const other = await user('other-teacher', UserRole.TEACHER);
      const otherExam = await exam(other.id);
      await attempt(otherExam.id, s.student.id, { score: 5 });
      await check(s.teacher.id, 0);
    });

    it('max_score = 0 contributes 0 percent (fires, as today)', async () => {
      const s = await clean();
      const e = await exam(s.teacher.id);
      await attempt(e.id, s.student.id, { score: 0, max: 0 });
      await check(s.teacher.id, 1);
    });

    it('null score_total counts as 0 percent', async () => {
      const s = await clean();
      const e = await exam(s.teacher.id);
      await attempt(e.id, s.student.id, { score: null });
      await check(s.teacher.id, 1);
    });

    it('rounding boundary around the 60 threshold: parity with the JS path on every pair', async () => {
      const percentages = [59.98, 59.99, 60, 60.01, 60.02];
      let fired = 0;
      let quiet = 0;
      for (const a of percentages) {
        for (const b of percentages) {
          const s = await clean();
          const e = await exam(s.teacher.id);
          await attempt(e.id, s.student.id, { score: a });
          await attempt(e.id, s.student.id, { score: b });
          if ((await check(s.teacher.id)) === 1) fired += 1;
          else quiet += 1;
        }
      }
      // The sweep straddles the threshold, so both outcomes were really exercised.
      expect(fired).toBeGreaterThan(0);
      expect(quiet).toBeGreaterThan(0);
    });

    it('three attempts whose mean lands on an x.xx5 boundary', async () => {
      const s = await clean();
      const e = await exam(s.teacher.id);
      await attempt(e.id, s.student.id, { score: 59.99 });
      await attempt(e.id, s.student.id, { score: 60 });
      await attempt(e.id, s.student.id, { score: 59.995 });
      await check(s.teacher.id);
    });
  });

  describe('attendance (E8-E9)', () => {
    // One attendance row per (student, lesson) is a unique key, so each record gets its own own-teacher lesson.
    const ownRecord = async (sc: Scenario, status: string): Promise<string> =>
      attendance(sc.student.id, (await lesson(sc.teacher.id)).id, status);

    it('low rate fires; exactly 70 percent does not', async () => {
      const low = await clean();
      await ownRecord(low, 'present');
      await ownRecord(low, 'absent');
      await check(low.teacher.id, 1);

      const edge = await clean();
      for (let i = 0; i < 7; i += 1) await ownRecord(edge, 'present');
      for (let i = 0; i < 3; i += 1) await ownRecord(edge, 'absent');
      await check(edge.teacher.id, 0);
    });

    it('late counts as present; 2 of 3 rounds to 67 and fires', async () => {
      const s = await clean();
      await ownRecord(s, 'late');
      await ownRecord(s, 'present');
      await ownRecord(s, 'absent');
      await check(s.teacher.id, 1);
    });

    it("attendance on a soft-deleted lesson, or on another teacher's lesson, is ignored", async () => {
      const s = await clean();
      const deleted = await lesson(s.teacher.id, true);
      await attendance(s.student.id, deleted.id, 'absent');
      const other = await user('other-teacher', UserRole.TEACHER);
      const foreign = await lesson(other.id);
      await attendance(s.student.id, foreign.id, 'absent');
      await check(s.teacher.id, 0);
    });
  });

  describe('last activity (E10)', () => {
    it('inactivity beyond 14 days fires; 13 days does not', async () => {
      const stale = await clean();
      await session(stale.student.id, stale.ownLesson.id, 15);
      await check(stale.teacher.id, 1);

      const recent = await clean();
      await session(recent.student.id, recent.ownLesson.id, 13);
      await check(recent.teacher.id, 0);
    });

    it('a stale session on a soft-deleted lesson or on a foreign lesson alone does not count as activity', async () => {
      const onDeleted = await clean();
      const deleted = await lesson(onDeleted.teacher.id, true);
      await session(onDeleted.student.id, deleted.id, 60);
      await check(onDeleted.teacher.id, 0);

      const onForeign = await clean();
      const other = await user('other-teacher', UserRole.TEACHER);
      const foreign = await lesson(other.id);
      await session(onForeign.student.id, foreign.id, 60);
      await check(onForeign.teacher.id, 0);
    });

    it('an old session on a soft-deleted or foreign lesson is ignored; the latest own session wins', async () => {
      const s = await clean();
      const deleted = await lesson(s.teacher.id, true);
      await session(s.student.id, deleted.id, 60);
      const other = await user('other-teacher', UserRole.TEACHER);
      const foreign = await lesson(other.id);
      await session(s.student.id, foreign.id, 60);
      await session(s.student.id, s.ownLesson.id, 20);
      await session(s.student.id, s.ownLesson.id, 2);
      await check(s.teacher.id, 0);
    });
  });

  describe('guardian (E13-E15)', () => {
    it('no guardian, unverified, or opted out each fire', async () => {
      const none = await clean({ guardian: false });
      await check(none.teacher.id, 1);

      const unverified = await clean({ guardian: false });
      await guardian(unverified.student.id, { primary: true, verified: false });
      await check(unverified.teacher.id, 1);

      const optedOut = await clean({ guardian: false });
      await guardian(optedOut.student.id, { primary: true, optedOut: true });
      await check(optedOut.teacher.id, 1);
    });

    it('the primary guardian is the one judged, not a better secondary', async () => {
      const s = await clean({ guardian: false });
      await guardian(s.student.id, { primary: false, verified: true, createdAt: daysAgo(30) });
      await guardian(s.student.id, { primary: true, verified: false, createdAt: daysAgo(1) });
      await check(s.teacher.id, 1);
    });

    it('a soft-deleted primary guardian is skipped and the next one is judged', async () => {
      const s = await clean({ guardian: false });
      await guardian(s.student.id, { primary: true, deleted: true });
      await guardian(s.student.id, { primary: false, verified: true });
      await check(s.teacher.id, 0);

      const only = await clean({ guardian: false });
      await guardian(only.student.id, { primary: true, deleted: true });
      await check(only.teacher.id, 1);
    });

    it('equal created_at ties resolve deterministically by link id (determinism fix, not parity)', async () => {
      const same = daysAgo(10);
      const s = await clean({ guardian: false });
      const first = await guardian(s.student.id, {
        primary: true,
        verified: true,
        createdAt: same,
      });
      const second = await guardian(s.student.id, {
        primary: true,
        verified: false,
        createdAt: same,
      });
      // `sg.id ASC` decides; assert the SQL picks the lower link id whichever guardian that is.
      const lowerIsVerified = first.linkId < second.linkId;
      expect((await followUp.getAnalyticsSummary(s.teacher.id)).riskStudentCount).toBe(
        lowerIsVerified ? 0 : 1,
      );
    });
  });

  describe('parent messages (E12, E16-E18)', () => {
    async function ownGradedAttempt(s: Scenario): Promise<ExamAttempt> {
      const e = await exam(s.teacher.id);
      return attempt(e.id, s.student.id, { score: 90 });
    }

    it('three delivered and none read fires; one read clears it', async () => {
      const s = await clean();
      const a = await ownGradedAttempt(s);
      const g = (await guardian(s.student.id)).guardian;
      for (let i = 0; i < 3; i += 1)
        await message(
          s.student.id,
          g.id,
          ParentEventType.EXAM_GRADED,
          a.id,
          ParentMessageStatus.DELIVERED,
        );
      await check(s.teacher.id, 1);

      const t = await clean();
      const b = await ownGradedAttempt(t);
      const g2 = (await guardian(t.student.id)).guardian;
      for (let i = 0; i < 2; i += 1)
        await message(
          t.student.id,
          g2.id,
          ParentEventType.EXAM_GRADED,
          b.id,
          ParentMessageStatus.DELIVERED,
        );
      await message(
        t.student.id,
        g2.id,
        ParentEventType.EXAM_GRADED,
        b.id,
        ParentMessageStatus.READ,
      );
      await check(t.teacher.id, 0);
    });

    it('two delivered is below the sample size', async () => {
      const s = await clean();
      const a = await ownGradedAttempt(s);
      const g = (await guardian(s.student.id)).guardian;
      for (let i = 0; i < 2; i += 1)
        await message(
          s.student.id,
          g.id,
          ParentEventType.EXAM_GRADED,
          a.id,
          ParentMessageStatus.DELIVERED,
        );
      await check(s.teacher.id, 0);
    });

    it("messages about another teacher's exam are not counted for a shared student", async () => {
      const s = await clean();
      const other = await user('other-teacher', UserRole.TEACHER);
      const otherExam = await exam(other.id);
      const foreign = await attempt(otherExam.id, s.student.id, { score: 90 });
      const g = (await guardian(s.student.id)).guardian;
      for (let i = 0; i < 4; i += 1)
        await message(
          s.student.id,
          g.id,
          ParentEventType.EXAM_GRADED,
          foreign.id,
          ParentMessageStatus.DELIVERED,
        );
      await check(s.teacher.id, 0);
    });

    it('a message about a non-graded attempt still counts toward the message figures', async () => {
      const s = await clean();
      const e = await exam(s.teacher.id);
      const pending = await attempt(e.id, s.student.id, { score: null, state: 'submitted' });
      const g = (await guardian(s.student.id)).guardian;
      for (let i = 0; i < 3; i += 1)
        await message(
          s.student.id,
          g.id,
          ParentEventType.EXAM_GRADED,
          pending.id,
          ParentMessageStatus.DELIVERED,
        );
      await check(s.teacher.id, 1);
    });

    it('a message about an attempt on a soft-deleted exam is not counted', async () => {
      const s = await clean();
      const e = await exam(s.teacher.id, true);
      const gone = await attempt(e.id, s.student.id, { score: 90 });
      const g = (await guardian(s.student.id)).guardian;
      for (let i = 0; i < 3; i += 1)
        await message(
          s.student.id,
          g.id,
          ParentEventType.EXAM_GRADED,
          gone.id,
          ParentMessageStatus.DELIVERED,
        );
      await check(s.teacher.id, 0);
    });

    it('attendance_marked messages on own attendance count; on a soft-deleted lesson they do not', async () => {
      const s = await clean();
      const g = (await guardian(s.student.id)).guardian;
      const rec = await attendance(s.student.id, s.ownLesson.id, 'present');
      for (let i = 0; i < 3; i += 1)
        await message(
          s.student.id,
          g.id,
          ParentEventType.ATTENDANCE_MARKED,
          rec,
          ParentMessageStatus.DELIVERED,
        );
      await check(s.teacher.id, 1);

      const t = await clean();
      const g2 = (await guardian(t.student.id)).guardian;
      const deleted = await lesson(t.teacher.id, true);
      const rec2 = await attendance(t.student.id, deleted.id, 'present');
      for (let i = 0; i < 3; i += 1)
        await message(
          t.student.id,
          g2.id,
          ParentEventType.ATTENDANCE_MARKED,
          rec2,
          ParentMessageStatus.DELIVERED,
        );
      await check(t.teacher.id, 0);
    });

    it('other event types are ignored', async () => {
      const s = await clean();
      const g = (await guardian(s.student.id)).guardian;
      const a = await ownGradedAttempt(s);
      for (let i = 0; i < 3; i += 1)
        await message(
          s.student.id,
          g.id,
          ParentEventType.HOMEWORK_ASSIGNED,
          a.id,
          ParentMessageStatus.DELIVERED,
        );
      await check(s.teacher.id, 0);
    });
  });

  describe('homework (E11)', () => {
    it('low completion fires; a fully submitted on-time homework does not', async () => {
      const low = await clean();
      await homework(low.ownLesson.id, low.student.id, { submitted: false });
      await homework(low.ownLesson.id, low.student.id, { submitted: true });
      await check(low.teacher.id, 1);

      const ok = await clean();
      await homework(ok.ownLesson.id, ok.student.id, { submitted: true });
      await check(ok.teacher.id, 0);
    });

    it('a late submission fires only when completion is not already below 70 percent', async () => {
      const late = await clean();
      await homework(late.ownLesson.id, late.student.id, { submitted: true, late: true });
      await check(late.teacher.id, 1);
    });

    it('no assigned homework leaves null completion and zero late (no factor)', async () => {
      const s = await clean();
      await check(s.teacher.id, 0);
    });
  });

  describe('population (E1-E2)', () => {
    it('a teacher with no students counts 0', async () => {
      const teacher = await user('lonely-teacher', UserRole.TEACHER);
      await check(teacher.id, 0);
    });

    it('a soft-deleted student is excluded even when otherwise at risk', async () => {
      const teacher = await user('teacher', UserRole.TEACHER);
      const gone = await user('gone', UserRole.STUDENT, true);
      const l = await lesson(teacher.id);
      await buy(gone.id, l.id);
      await check(teacher.id, 0);
    });

    it("a student shared with a second teacher is counted once per teacher, on that teacher's own data", async () => {
      const a = await clean({ guardian: false });
      const b = await user('teacher-b', UserRole.TEACHER);
      const lb = await lesson(b.id);
      await buy(a.student.id, lb.id);
      await check(a.teacher.id, 1);
      await check(b.id, 1);
    });
  });

  it('many at-risk and healthy students together: counts match', async () => {
    const teacher = await user('bulk-teacher', UserRole.TEACHER);
    const l = await lesson(teacher.id);
    const e = await exam(teacher.id);
    let expectedRisky = 0;
    for (let i = 0; i < 12; i += 1) {
      const s = await user(`bulk-${String(i)}`);
      await buy(s.id, l.id);
      if (i % 3 !== 0) await guardian(s.id, { primary: true });
      else expectedRisky += 1; // no guardian
      if (i % 4 === 1) {
        await attempt(e.id, s.id, { score: 20 });
        expectedRisky += 1;
      }
    }
    const old = await oldCount(teacher.id);
    expect((await followUp.getAnalyticsSummary(teacher.id)).riskStudentCount).toBe(old);
    expect(old).toBeGreaterThan(0);
    expect(expectedRisky).toBeGreaterThanOrEqual(old);
  });

  describe('route: GET /reports/teacher/follow-up', () => {
    it('returns the same three figures as the full report, in at most 7 statements on a miss', async () => {
      const s = await clean({ guardian: false });
      const auth = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const l = await lesson(auth.userId);
      await buy(s.student.id, l.id);
      await guardian(s.student.id, { primary: true, verified: false });

      counter.start();
      const res = await auth.agent
        .get(`${API_PREFIX}/reports/teacher/follow-up`)
        .set('X-Request-Id', 'tfr-follow-up-1')
        .expect(200);
      counter.stop();

      const data = res.body.data ?? res.body;
      expect(data).toEqual({
        guardians: expect.objectContaining({ total: 1, pending: 1 }),
        notifications: expect.objectContaining({ today: 0 }),
        riskStudentCount: 1,
      });
      expect(Object.keys(data).sort()).toEqual(['guardians', 'notifications', 'riskStudentCount']);

      const statements = counter.count({ requestId: 'tfr-follow-up-1' });
      // Includes the auth guard's own reads; the follow-up work itself is 4 statements.
      expect(statements).toBeLessThanOrEqual(7);

      // The same three figures feed `/reports/teacher/summary` through the unchanged `getAnalyticsSummary`.
      // That route is not asserted here: its revenue read (`getTeacherRevenueStats`, `createQueryBuilder('order')`)
      // fails on a reserved-word alias in this schema on the unmodified code too, independent of T077.
    });

    it("is teacher-only and scoped by the token: a student gets 403, teacher B never sees teacher A's students", async () => {
      const a = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const b = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const studentAuth = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
      const owned = await user('owned-by-a');
      const l = await lesson(a.userId);
      await buy(owned.id, l.id);

      await studentAuth.agent.get(`${API_PREFIX}/reports/teacher/follow-up`).expect(403);

      const asA = await a.agent.get(`${API_PREFIX}/reports/teacher/follow-up`).expect(200);
      expect((asA.body.data ?? asA.body).riskStudentCount).toBe(1);

      const asB = await b.agent.get(`${API_PREFIX}/reports/teacher/follow-up`).expect(200);
      expect((asB.body.data ?? asB.body).riskStudentCount).toBe(0);
    });
  });
});
