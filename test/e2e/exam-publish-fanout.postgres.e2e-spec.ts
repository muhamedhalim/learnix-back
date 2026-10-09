import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { Exam } from '../../src/exams/entities/exam.entity';
import { ExamQuestion } from '../../src/exams/entities/exam-question.entity';
import { ExamSection } from '../../src/exams/entities/exam-section.entity';
import { ExamStatus } from '../../src/exams/entities/exam-status.enum';
import { Question } from '../../src/exams/entities/question.entity';
import { ExamAuthoringService } from '../../src/exams/services/exam-authoring.service';
import { PreferredLanguage } from '../../src/guardians/entities/preferred-language.enum';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { Notification, NotificationType } from '../../src/notifications/entities';
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
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { createE2EApp, resetDatabase, type E2EContext } from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

jest.setTimeout(120_000);

/**
 * T069: publishing an exam to a lesson audience creates exactly one localized
 * notification per student with ONE multi-row INSERT per 500 recipients (it used
 * to be one INSERT per student), and re-publishing never dedupes.
 */
describe('Exam publish notification fan-out (postgres)', () => {
  let ctx: E2EContext;
  let authoring: ExamAuthoringService;
  let counter: StatementCounter;

  beforeAll(async () => {
    ctx = await createE2EApp();
    authoring = ctx.app.get(ExamAuthoringService);
    counter = new StatementCounter(ctx.dataSource);
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const ds = (): DataSource => ctx.dataSource;

  async function seedExam(): Promise<{ examId: string; teacherId: string; lessonId: string }> {
    const users = ds().getRepository(User);
    const teacher = await users.save(
      users.create({
        username: 'epf-teacher',
        name: 'EPF Teacher',
        first_name: null,
        last_name: null,
        email: 'epf-teacher@example.test',
        phone: '01270000001',
        role: UserRole.TEACHER,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    const subjects = ds().getRepository(Subject);
    const subject = await subjects.save(
      subjects.create({
        name: 'EPF subject',
        description: null,
        description_ar: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
    const lessons = ds().getRepository(Lesson);
    const lesson = await lessons.save(
      lessons.create({
        title: 'EPF lesson',
        description: null,
        teacher_id: teacher.id,
        subject_id: subject.id,
        thumbnail: null,
        price: 0,
        duration: 600,
        is_group: true,
        available_for_days: 30,
        students_count: 0,
        is_free_preview: false,
      }),
    );
    const exams = ds().getRepository(Exam);
    const exam = await exams.save(
      exams.create({
        teacher_id: teacher.id,
        subject_id: subject.id,
        lesson_id: lesson.id,
        package_id: null,
        title: 'Midterm',
        title_ar: 'اختبار نصفي',
        description: null,
        description_ar: null,
        is_public: false,
        status: ExamStatus.DRAFT,
        config: {},
        total_marks: 10,
        passing_marks: 5,
      } as never) as unknown as Exam,
    );
    const sections = ds().getRepository(ExamSection);
    const section = await sections.save(
      sections.create({
        exam_id: exam.id,
        order_index: 0,
        title: null,
        title_ar: null,
        description: null,
        description_ar: null,
        shuffle_questions: false,
      }),
    );
    const questions = ds().getRepository(Question);
    const question = await questions.save(
      questions.create({
        teacher_id: teacher.id,
        subject_id: subject.id,
        lesson_id: null,
        chapter: null,
        topic: null,
        type: 'single_choice',
        difficulty: null,
        bloom_level: null,
        content: {},
        answer_key: {},
        default_marks: 1,
        tags: [],
        current_version: 1,
        is_active: true,
        is_public: false,
      } as never) as unknown as Question,
    );
    const examQuestions = ds().getRepository(ExamQuestion);
    await examQuestions.save(
      examQuestions.create({
        exam_id: exam.id,
        section_id: section.id,
        question_id: question.id,
        question_version: 1,
        type_snapshot: 'single_choice',
        content_snapshot: {},
        answer_key_snapshot: {},
        order_index: 0,
        marks: 1,
        weight: 1,
        is_bonus: false,
        required: true,
      } as never) as unknown as ExamQuestion,
    );
    return { examId: exam.id, teacherId: teacher.id, lessonId: lesson.id };
  }

  async function enrol(lessonId: string, count: number): Promise<string[]> {
    const users = ds().getRepository(User);
    const students = await users.save(
      Array.from({ length: count }, (_unused, index) =>
        users.create({
          username: `epf-s${String(index)}`,
          name: `EPF Student ${String(index)}`,
          first_name: null,
          last_name: null,
          email: `epf-s${String(index)}@example.test`,
          phone: `0128${String(index).padStart(7, '0')}`,
          role: UserRole.STUDENT,
          status: UserStatus.APPROVED,
          is_active: true,
          password_hash: null,
          preferred_language: index % 3 === 0 ? PreferredLanguage.EN : PreferredLanguage.AR,
        }),
      ),
      { chunk: 200 },
    );
    const payments = ds().getRepository(Payment);
    const savedPayments = await payments.save(
      students.map((student, index) =>
        payments.create({
          order_id: null,
          user_id: student.id,
          item_type: ItemType.LESSON,
          item_id: lessonId,
          amount: 0,
          discount_amount: 0,
          final_amount: 0,
          amount_minor: 0,
          currency: 'EGP',
          channel: PaymentChannel.MANUAL,
          provider: null,
          provider_reference: `epf-${String(index)}`,
          status: PaymentStatus.COMPLETED,
          payment_method: PaymentMethod.MANUAL,
          paymob_order_id: null,
          paymob_transaction_id: null,
          idempotency_key: `epf-${randomUUID()}`,
          failure_reason: null,
          completed_at: new Date(),
        }),
      ),
      { chunk: 200 },
    );
    const purchases = ds().getRepository(LessonPurchase);
    await purchases.save(
      students.map((student, index) =>
        purchases.create({
          student_id: student.id,
          lesson_id: lessonId,
          payment_id: savedPayments[index]!.id,
          price_paid: 0,
          access_granted_at: new Date(),
          access_expires_at: new Date(Date.now() + 86_400_000),
          days_extended: 0,
          revoked_at: null,
          revocation_reason: null,
        }),
      ),
      { chunk: 200 },
    );
    return students.map((student) => student.id);
  }

  const insertsIntoNotifications = (): number =>
    counter
      .statements()
      .filter((statement) => statement.sql.startsWith('INSERT INTO "notifications"')).length;

  it('creates one localized notification per student with a single multi-row INSERT', async () => {
    const { examId, teacherId, lessonId } = await seedExam();
    const studentIds = await enrol(lessonId, 7);

    counter.start();
    await authoring.publish(examId, teacherId);
    counter.stop();

    const rows = await ds()
      .getRepository(Notification)
      .find({ order: { created_at: 'ASC' } });
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.user_id).sort()).toEqual([...studentIds].sort());
    const users = await ds().getRepository(User).findBy({});
    const languageOf = new Map(users.map((user) => [user.id, user.preferred_language]));
    for (const row of rows) {
      const arabic = languageOf.get(row.user_id) === PreferredLanguage.AR;
      expect(row).toMatchObject({
        type: NotificationType.EXAM_ASSIGNED,
        title: arabic ? 'امتحان جديد' : 'New exam',
        message: arabic ? 'اختبار نصفي' : 'Midterm',
        is_read: false,
        sms_sent: false,
        attempts: 0,
        origin: 'system',
        status: 'sent',
        dedupe_key: null,
      });
      expect(row.data).toMatchObject({ exam_id: examId, href: `/student/exams/${examId}` });
    }
    expect(insertsIntoNotifications()).toBe(1);
    await expect(ds().getRepository(Exam).findOneByOrFail({ id: examId })).resolves.toMatchObject({
      status: ExamStatus.PUBLISHED,
    });
  });

  it('chunks 501 recipients into two INSERTs and loses no row', async () => {
    const { examId, teacherId, lessonId } = await seedExam();
    await enrol(lessonId, 501);

    counter.start();
    await authoring.publish(examId, teacherId);
    counter.stop();

    await expect(ds().getRepository(Notification).count()).resolves.toBe(501);
    expect(insertsIntoNotifications()).toBe(2);
  });

  it('re-publishing after a reschedule still creates new notifications (no dedupe key)', async () => {
    const { examId, teacherId, lessonId } = await seedExam();
    await enrol(lessonId, 3);
    await authoring.publish(examId, teacherId);

    await authoring.reschedule(examId, teacherId, {
      start_window_at: new Date(Date.now() + 3_600_000).toISOString(),
    } as never);

    const rows = await ds().getRepository(Notification).find();
    expect(rows).toHaveLength(6);
    expect(
      rows.filter(
        (row) => row.title === 'Exam schedule updated' || row.title === 'تم تحديث موعد الامتحان',
      ),
    ).toHaveLength(3);
  });
});
