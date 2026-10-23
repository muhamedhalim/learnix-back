import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { Exam } from '../../src/exams/entities/exam.entity';
import { ExamAttempt } from '../../src/exams/entities/exam-attempt.entity';
import { ExamAttemptAnswer } from '../../src/exams/entities/exam-attempt-answer.entity';
import { ExamQuestion } from '../../src/exams/entities/exam-question.entity';
import { ExamSection } from '../../src/exams/entities/exam-section.entity';
import { ExamStatus } from '../../src/exams/entities/exam-status.enum';
import { Question } from '../../src/exams/entities/question.entity';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
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
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
  type E2EContext,
} from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

jest.setTimeout(120_000);

/**
 * T072 against PostgreSQL: the duplicate exam/answer reads are gone while the guards stay —
 * the audience-scoped lookup on every autosave, the distinct 404 bodies on grading, the locked
 * exam read inside finalize — and the reorder is one statement scoped by the exam.
 */
describe('Exam attempt reads (postgres)', () => {
  let ctx: E2EContext;
  let counter: StatementCounter;

  beforeAll(async () => {
    ctx = await createE2EApp();
    counter = new StatementCounter(ctx.dataSource);
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const ds = (): DataSource => ctx.dataSource;
  const handlerStatements = (requestId: string): string[] =>
    counter
      .statements({ requestId })
      .map((statement) => statement.sql)
      .filter((sql) => !sql.includes('"session"."id"'));

  interface Seed {
    teacher: AuthenticatedUser;
    student: AuthenticatedUser;
    lessonId: string;
    subjectId: string;
    examId: string;
    examQuestionIds: string[];
    purchaseId: string;
  }

  async function seedExam(
    teacher: AuthenticatedUser,
    subjectId: string,
    lessonId: string | null,
    questionCount: number,
    status: ExamStatus,
  ): Promise<{ examId: string; examQuestionIds: string[]; sectionIds: string[] }> {
    const exams = ds().getRepository(Exam);
    const exam = await exams.save(
      exams.create({
        teacher_id: teacher.userId,
        subject_id: subjectId,
        lesson_id: lessonId,
        package_id: null,
        title: 'Reads exam',
        title_ar: 'اختبار',
        description: null,
        description_ar: null,
        is_public: false,
        status,
        config: {
          duration_seconds: 600,
          grace_seconds: 30,
          attempts_allowed: 3,
          review_policy: 'after_submit',
          shuffle_questions: false,
          shuffle_choices: false,
          start_window_at: null,
          end_window_at: null,
        },
        total_marks: questionCount,
        passing_marks: 1,
      } as never) as unknown as Exam,
    );
    const sections = ds().getRepository(ExamSection);
    const sectionIds: string[] = [];
    const questions = ds().getRepository(Question);
    const examQuestions = ds().getRepository(ExamQuestion);
    const examQuestionIds: string[] = [];
    for (let i = 0; i < questionCount; i += 1) {
      const section = await sections.save(
        sections.create({
          exam_id: exam.id,
          order_index: i,
          title: `Section ${String(i)}`,
          title_ar: null,
          description: null,
          description_ar: null,
          shuffle_questions: false,
        }),
      );
      sectionIds.push(section.id);
      const question = await questions.save(
        questions.create({
          teacher_id: teacher.userId,
          subject_id: subjectId,
          lesson_id: null,
          chapter: null,
          topic: null,
          type: 'essay',
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
      const examQuestion = await examQuestions.save(
        examQuestions.create({
          exam_id: exam.id,
          section_id: section.id,
          question_id: question.id,
          question_version: 1,
          type_snapshot: 'essay',
          content_snapshot: { prompt: `Q${String(i)}` },
          answer_key_snapshot: {},
          order_index: i,
          marks: 1,
          weight: 1,
          is_bonus: false,
          required: true,
        } as never) as unknown as ExamQuestion,
      );
      examQuestionIds.push(examQuestion.id);
    }
    return { examId: exam.id, examQuestionIds, sectionIds };
  }

  async function seed(): Promise<Seed> {
    const teacher = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
    const student = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const subjects = ds().getRepository(Subject);
    const subject = await subjects.save(
      subjects.create({
        name: 'Reads subject',
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
        title: 'Reads lesson',
        description: null,
        teacher_id: teacher.userId,
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
    const payments = ds().getRepository(Payment);
    const payment = await payments.save(
      payments.create({
        order_id: null,
        user_id: student.userId,
        item_type: ItemType.LESSON,
        item_id: lesson.id,
        amount: 0,
        discount_amount: 0,
        final_amount: 0,
        amount_minor: 0,
        currency: 'EGP',
        channel: PaymentChannel.MANUAL,
        provider: null,
        provider_reference: `reads-${randomUUID()}`,
        status: PaymentStatus.COMPLETED,
        payment_method: PaymentMethod.MANUAL,
        provider_order_reference: null,
        provider_transaction_id: null,
        idempotency_key: `reads-${randomUUID()}`,
        failure_reason: null,
        completed_at: new Date(),
      }),
    );
    const purchases = ds().getRepository(LessonPurchase);
    const purchase = await purchases.save(
      purchases.create({
        student_id: student.userId,
        lesson_id: lesson.id,
        payment_id: payment.id,
        price_paid: 0,
        access_granted_at: new Date(),
        access_expires_at: new Date(Date.now() + 86_400_000),
        days_extended: 0,
        revoked_at: null,
        revocation_reason: null,
      }),
    );
    const { examId, examQuestionIds } = await seedExam(
      teacher,
      subject.id,
      lesson.id,
      3,
      ExamStatus.PUBLISHED,
    );
    return {
      teacher,
      student,
      lessonId: lesson.id,
      subjectId: subject.id,
      examId,
      examQuestionIds,
      purchaseId: purchase.id,
    };
  }

  async function startAttempt(seeded: Seed): Promise<string> {
    const res = await seeded.student.agent
      .post(`${API_PREFIX}/student/exams/${seeded.examId}/start`)
      .expect(201);
    return (res.body as { attempt_id: string }).attempt_id;
  }

  describe('autosave', () => {
    it('saves only the named answer, with fewer statements than reading the whole attempt', async () => {
      const seeded = await seed();
      const attemptId = await startAttempt(seeded);

      counter.start();
      const res = await seeded.student.agent
        .patch(`${API_PREFIX}/student/exams/attempts/${attemptId}/answers`)
        .set('X-Request-Id', 'reads-autosave')
        .send({
          answers: [
            {
              exam_question_id: seeded.examQuestionIds[1],
              response: { text: 'hello' },
              time_spent_ms: 40,
            },
          ],
        })
        .expect(200);
      counter.stop();

      expect(res.body).toMatchObject({ saved: 1, state: 'in_progress' });
      const rows = await ds()
        .getRepository(ExamAttemptAnswer)
        .find({ where: { attempt_id: attemptId } });
      expect(rows.filter((row) => row.response !== null)).toHaveLength(1);
      expect(rows.find((row) => row.exam_question_id === seeded.examQuestionIds[1])).toMatchObject({
        response: { text: 'hello' },
        time_spent_ms: 40,
      });
      const sql = handlerStatements('reads-autosave');
      // attempt lookup, audience-scoped exam, the one named answer row, its question, and the save.
      expect(sql.filter((statement) => statement.includes('FROM "exams"'))).toHaveLength(1);
      // Was one more (the second exam read): attempt, exam, answer, question, then the save's own transaction.
      expect(sql).toHaveLength(8);
    });

    it('a refund mid-exam stops the very next autosave and changes nothing', async () => {
      const seeded = await seed();
      const attemptId = await startAttempt(seeded);
      await seeded.student.agent
        .patch(`${API_PREFIX}/student/exams/attempts/${attemptId}/answers`)
        .send({
          answers: [{ exam_question_id: seeded.examQuestionIds[0], response: { text: 'before' } }],
        })
        .expect(200);

      await ds().query('UPDATE lesson_purchases SET revoked_at = now() WHERE id = $1', [
        seeded.purchaseId,
      ]);

      await seeded.student.agent
        .patch(`${API_PREFIX}/student/exams/attempts/${attemptId}/answers`)
        .send({
          answers: [{ exam_question_id: seeded.examQuestionIds[0], response: { text: 'after' } }],
        })
        .expect(404);
      const row = await ds()
        .getRepository(ExamAttemptAnswer)
        .findOneByOrFail({ attempt_id: attemptId, exam_question_id: seeded.examQuestionIds[0]! });
      expect(row.response).toEqual({ text: 'before' });
    });

    it('a soft-deleted exam answers 404 for autosave and result', async () => {
      const seeded = await seed();
      const attemptId = await startAttempt(seeded);
      await ds().getRepository(Exam).softDelete({ id: seeded.examId });

      await seeded.student.agent
        .patch(`${API_PREFIX}/student/exams/attempts/${attemptId}/answers`)
        .send({
          answers: [{ exam_question_id: seeded.examQuestionIds[0], response: { text: 'x' } }],
        })
        .expect(404);
      await seeded.student.agent
        .get(`${API_PREFIX}/student/exams/${seeded.examId}/result`)
        .expect(404);
    });
  });

  describe('start, resume and result', () => {
    it('starting a new attempt does not re-read the exam or its questions to render', async () => {
      const seeded = await seed();

      counter.start();
      await seeded.student.agent
        .post(`${API_PREFIX}/student/exams/${seeded.examId}/start`)
        .set('X-Request-Id', 'reads-start')
        .expect(201);
      counter.stop();

      const sql = handlerStatements('reads-start');
      expect(sql.filter((statement) => statement.includes('FROM "exams"'))).toHaveLength(1);
      expect(sql.filter((statement) => statement.includes('FROM "exam_questions"'))).toHaveLength(
        1,
      );
      // Was two more (the render's exam and question reads).
      expect(sql).toHaveLength(10);
    });

    it('resuming an expired attempt still finalises under the attempt lock, reading the exam in the lock and re-reading the attempt', async () => {
      const seeded = await seed();
      const attemptId = await startAttempt(seeded);
      await ds().query(
        `UPDATE exam_attempts SET deadline_at = now() - interval '10 minutes', started_at = now() - interval '20 minutes' WHERE id = $1`,
        [attemptId],
      );

      counter.start();
      const res = await seeded.student.agent
        .post(`${API_PREFIX}/student/exams/${seeded.examId}/start`)
        .set('X-Request-Id', 'reads-resume')
        .expect(201);
      counter.stop();

      expect((res.body as { state: string }).state).not.toBe('in_progress');
      const attempt = await ds().getRepository(ExamAttempt).findOneByOrFail({ id: attemptId });
      expect(attempt.state).not.toBe('in_progress');
      const sql = handlerStatements('reads-resume');
      const begin = sql.findIndex((statement) => statement.startsWith('START TRANSACTION'));
      const commit = sql.findIndex(
        (statement, index) => index > begin && statement.startsWith('COMMIT'),
      );
      expect(begin).toBeGreaterThanOrEqual(0);
      const inTransaction = sql.slice(begin, commit + 1);
      // The attempt lock, then the exam read INSIDE the lock.
      expect(inTransaction.some((statement) => statement.includes('FOR UPDATE'))).toBe(true);
      expect(inTransaction.some((statement) => statement.includes('FROM "exams"'))).toBe(true);
      // The finalised attempt is re-read after the transaction (the resume then renders it).
      expect(
        sql.slice(commit + 1).some((statement) => statement.includes('FROM "exam_attempts"')),
      ).toBe(true);
      // Before the transaction: only the scoped lookup read the exam; none after except render's own none.
      expect(
        sql.slice(0, begin).filter((statement) => statement.includes('FROM "exams"')),
      ).toHaveLength(1);
      expect(
        sql.slice(commit + 1).filter((statement) => statement.includes('FROM "exams"')),
      ).toHaveLength(0);
    });

    it('ignores answers sent with a submit after deadline + grace (F-13)', async () => {
      const seeded = await seed();
      const attemptId = await startAttempt(seeded);
      await ds().query(
        `UPDATE exam_attempts SET deadline_at = now() - interval '10 minutes', started_at = now() - interval '20 minutes' WHERE id = $1`,
        [attemptId],
      );

      await seeded.student.agent
        .post(`${API_PREFIX}/student/exams/attempts/${attemptId}/submit`)
        .send({
          answers: [{ exam_question_id: seeded.examQuestionIds[0], response: { text: 'too late' } }],
        })
        .expect(201);

      const attempt = await ds().getRepository(ExamAttempt).findOneByOrFail({ id: attemptId });
      expect(attempt.state).not.toBe('in_progress');
      const answer = await ds()
        .getRepository(ExamAttemptAnswer)
        .findOneByOrFail({ attempt_id: attemptId, exam_question_id: seeded.examQuestionIds[0] });
      expect(answer.response).toBeNull();
    });

    it('the result costs one exam read (the scoped lookup)', async () => {
      const seeded = await seed();
      const attemptId = await startAttempt(seeded);
      await seeded.student.agent
        .post(`${API_PREFIX}/student/exams/attempts/${attemptId}/submit`)
        .send({ answers: [] })
        .expect(201);

      counter.start();
      const res = await seeded.student.agent
        .get(`${API_PREFIX}/student/exams/${seeded.examId}/result`)
        .set('X-Request-Id', 'reads-result')
        .expect(200);
      counter.stop();

      expect(res.body).toMatchObject({ exam_id: seeded.examId, available: true });
      expect(
        handlerStatements('reads-result').filter((statement) => statement.includes('FROM "exams"')),
      ).toHaveLength(1);
    });
  });

  describe('teacher grading', () => {
    it('grades one answer with the answer, attempt and question read in a single query', async () => {
      const seeded = await seed();
      const attemptId = await startAttempt(seeded);
      await seeded.student.agent
        .post(`${API_PREFIX}/student/exams/attempts/${attemptId}/submit`)
        .send({
          answers: [{ exam_question_id: seeded.examQuestionIds[0], response: { text: 'essay' } }],
        })
        .expect(201);
      const answer = await ds()
        .getRepository(ExamAttemptAnswer)
        .findOneByOrFail({ attempt_id: attemptId, exam_question_id: seeded.examQuestionIds[0]! });

      counter.start();
      const res = await seeded.teacher.agent
        .post(`${API_PREFIX}/teacher/exams/${seeded.examId}/answers/${answer.id}/grade`)
        .set('X-Request-Id', 'reads-grade')
        .send({ score: 1, feedback: 'good' })
        .expect(201);
      counter.stop();

      expect(res.body).toMatchObject({ attempt_id: attemptId });
      const graded = await ds().getRepository(ExamAttemptAnswer).findOneByOrFail({ id: answer.id });
      expect(graded).toMatchObject({
        score: 1,
        feedback: 'good',
        graded_by: seeded.teacher.userId,
        manual_required: false,
      });
      const sql = handlerStatements('reads-grade');
      // No standalone lookups of the answer, attempt or question before the transaction.
      const begin = sql.findIndex((statement) => statement.startsWith('START TRANSACTION'));
      const before = sql.slice(0, begin);
      expect(
        before.filter((statement) => statement.includes('FROM "exam_attempt_answers"')),
      ).toHaveLength(1);
      expect(
        before.filter(
          (statement) =>
            statement.includes('FROM "exam_attempts"') &&
            !statement.includes('exam_attempt_answers'),
        ),
      ).toHaveLength(0);
      expect(
        before.filter(
          (statement) =>
            statement.includes('FROM "exam_questions"') &&
            !statement.includes('exam_attempt_answers'),
        ),
      ).toHaveLength(0);
      // Was two more (separate attempt and question lookups).
      expect(sql).toHaveLength(12);
    });

    it("keeps the two distinct 404s: another exam's answer vs an unknown answer, and the exam-owner guard", async () => {
      const seeded = await seed();
      const attemptId = await startAttempt(seeded);
      const answer = await ds()
        .getRepository(ExamAttemptAnswer)
        .findOneByOrFail({ attempt_id: attemptId, exam_question_id: seeded.examQuestionIds[0]! });
      const other = await seedExam(seeded.teacher, seeded.subjectId, null, 1, ExamStatus.PUBLISHED);

      const foreign = await seeded.teacher.agent
        .post(`${API_PREFIX}/teacher/exams/${other.examId}/answers/${answer.id}/grade`)
        .send({ score: 1 });
      const unknown = await seeded.teacher.agent
        .post(`${API_PREFIX}/teacher/exams/${seeded.examId}/answers/${randomUUID()}/grade`)
        .send({ score: 1 });

      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(JSON.stringify(foreign.body)).toContain('does not belong to this exam');
      expect(JSON.stringify(unknown.body)).toContain('Answer not found');
      const untouched = await ds()
        .getRepository(ExamAttemptAnswer)
        .findOneByOrFail({ id: answer.id });
      expect(untouched.score).toBeNull();

      // A teacher who does not own the exam is refused before any answer is looked up.
      const intruder = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const denied = await intruder.agent
        .post(`${API_PREFIX}/teacher/exams/${seeded.examId}/answers/${answer.id}/grade`)
        .send({ score: 1 });
      expect([403, 404]).toContain(denied.status);
      const stillUntouched = await ds()
        .getRepository(ExamAttemptAnswer)
        .findOneByOrFail({ id: answer.id });
      expect(stillUntouched.score).toBeNull();
    });
  });

  describe('reorder', () => {
    it('orders sections and questions in one statement each, and a foreign exam is never touched', async () => {
      const seeded = await seed();
      const draft = await seedExam(seeded.teacher, seeded.subjectId, null, 3, ExamStatus.DRAFT);
      const otherDraft = await seedExam(
        seeded.teacher,
        seeded.subjectId,
        null,
        3,
        ExamStatus.DRAFT,
      );
      const reversedSections = [...draft.sectionIds].reverse();
      const reversedQuestions = [...draft.examQuestionIds].reverse();

      counter.start();
      await seeded.teacher.agent
        .patch(`${API_PREFIX}/teacher/exams/${draft.examId}/sections/reorder`)
        .set('X-Request-Id', 'reads-reorder-sections')
        .send({ ids: reversedSections })
        .expect(200);
      await seeded.teacher.agent
        .patch(`${API_PREFIX}/teacher/exams/${draft.examId}/questions/reorder`)
        .set('X-Request-Id', 'reads-reorder-questions')
        .send({ ids: reversedQuestions })
        .expect(200);
      counter.stop();

      const orderOf = async (table: string, examId: string): Promise<string[]> =>
        (
          (await ds().query(`SELECT id FROM ${table} WHERE exam_id = $1 ORDER BY order_index ASC`, [
            examId,
          ])) as Array<{
            id: string;
          }>
        ).map((row) => row.id);
      expect(await orderOf('exam_sections', draft.examId)).toEqual(reversedSections);
      expect(await orderOf('exam_questions', draft.examId)).toEqual(reversedQuestions);
      // The other exam keeps its authored order.
      expect(await orderOf('exam_sections', otherDraft.examId)).toEqual(otherDraft.sectionIds);
      for (const requestId of ['reads-reorder-sections', 'reads-reorder-questions']) {
        const updates = handlerStatements(requestId).filter((statement) =>
          statement.startsWith('UPDATE'),
        );
        expect(updates).toHaveLength(1);
      }

      // Another exam's ids in the payload are refused outright, and nothing moves.
      await seeded.teacher.agent
        .patch(`${API_PREFIX}/teacher/exams/${draft.examId}/sections/reorder`)
        .send({ ids: [...otherDraft.sectionIds] })
        .expect(400);
      expect(await orderOf('exam_sections', draft.examId)).toEqual(reversedSections);
      expect(await orderOf('exam_sections', otherDraft.examId)).toEqual(otherDraft.sectionIds);
    });
  });
});
