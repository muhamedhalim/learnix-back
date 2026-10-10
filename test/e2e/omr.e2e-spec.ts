import type { Server } from 'node:http';

import { getRepositoryToken } from '@nestjs/typeorm';

import request from 'supertest';

import { JOB_TYPES } from '../../src/queues/queues.constants';
import { OmrProcessor } from '../../src/exams/processors/omr.processor';
import { OmrSheet, OmrTemplate } from '../../src/exams/entities';
import type { OmrTemplateLayout } from '../../src/exams/entities/omr-template.types';
import { OMR_RECOGNITION_PROVIDER } from '../../src/exams/omr-recognition/omr-recognition.interface';
import { renderFixtureSheet } from '../../src/exams/omr-recognition/fixtures/build-fixture';
import { StorageService } from '../../src/storage/storage.service';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
  type E2EContext,
} from './fixtures';

interface SheetRow {
  id: string;
  status: string;
  template_id: string | null;
}

/**
 * Teacher OMR workflow (DEF-004): generate a sheet → scan a real (fixture)
 * image → the CV pipeline derives answers from it → teacher review/confirm →
 * the existing Attempt/grading engine grades it — end to end, with no
 * client-supplied `detected_answers` anywhere on the wire.
 *
 * Background workers are disabled in this env (`E2E_DISABLE_BACKGROUND_WORKERS`),
 * so `OmrProcessor` is never registered as a Nest provider (see the
 * conditional registration in `exams.module.ts`) — it's constructed directly
 * here from the same repositories/provider the app itself uses, and `.process()`
 * is invoked synchronously wherever the real queue would otherwise run it.
 */
jest.setTimeout(30000); // image recognition (sharp decode + jsQR + homography) takes longer than Jest's 5s default

describe('Teacher OMR workflow (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;
  let processor: OmrProcessor;

  let teacher: AuthenticatedUser;
  let otherTeacher: AuthenticatedUser;
  let student: AuthenticatedUser;
  let subjectId: string;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
    processor = new OmrProcessor(
      ctx.app.get(getRepositoryToken(OmrSheet)),
      ctx.app.get(getRepositoryToken(OmrTemplate)),
      ctx.app.get(StorageService),
      ctx.app.get(OMR_RECOGNITION_PROVIDER),
    );
  });

  afterAll(async () => ctx.app.close());

  beforeEach(async () => {
    // A confirmed OMR sheet funnels through the same `finalize()` → `ExamGradedPublisher`
    // path as any graded attempt, which emits a fire-and-forget EventEmitter2 event
    // (`{ async: true }`) consumed by the parent-notification listener — genuinely
    // not awaited by the request that triggered it. Give that in-flight work a beat
    // to finish before truncating everything out from under it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await resetDatabase(ctx.dataSource);
    teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'teacher',
      overrides: { requestedRole: 'teacher' },
    });
    otherTeacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'teacher',
      overrides: { requestedRole: 'teacher' },
    });
    student = await createAuthenticatedUser(ctx.app, ctx.dataSource);

    const [{ id }] = (await ctx.dataSource.query(
      `INSERT INTO subjects (id, name) VALUES (gen_random_uuid(), 'OMR Test Subject') RETURNING id`,
    )) as [{ id: string }];
    subjectId = id;
  });

  // ---------- seeding helpers (raw SQL, bypassing the authoring/purchase flows) ----------

  /** Grants `studentId` private-audience access to every exam owned by `teacherId` (no lesson/package on the exam itself). */
  async function grantInstructorRosterAccess(studentId: string, teacherId: string): Promise<void> {
    const [{ id: lessonId }] = (await ctx.dataSource.query(
      `INSERT INTO lessons (id, title, teacher_id, subject_id, price, version) VALUES (gen_random_uuid(), 'Roster Lesson', $1, $2, 100, 1) RETURNING id`,
      [teacherId, subjectId],
    )) as [{ id: string }];
    const [{ id: paymentId }] = (await ctx.dataSource.query(
      `INSERT INTO payments (id, user_id, item_type, item_id, amount, final_amount, idempotency_key)
       VALUES (gen_random_uuid(), $1, 'lesson', $2, 100, 100, $3) RETURNING id`,
      [studentId, lessonId, `idem-${studentId}-${lessonId}`],
    )) as [{ id: string }];
    await ctx.dataSource.query(
      `INSERT INTO lesson_purchases (id, student_id, lesson_id, payment_id, price_paid, access_granted_at, access_expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 100, now(), now() + interval '30 days')`,
      [studentId, lessonId, paymentId],
    );
  }

  async function seedExam(teacherId: string, status = 'published'): Promise<string> {
    const config = {
      duration_seconds: 3600,
      attempts_allowed: 1,
      start_window_at: null,
      end_window_at: null,
      shuffle_questions: false,
      shuffle_choices: false,
      review_policy: 'after_graded',
      negative_marking: false,
      show_score_immediately: true,
      grace_seconds: 30,
    };
    const [{ id }] = (await ctx.dataSource.query(
      `INSERT INTO exams (id, teacher_id, subject_id, title, title_ar, status, is_public, config, total_marks, passing_marks)
       VALUES (gen_random_uuid(), $1, $2, 'OMR Midterm', 'اختبار', $3, false, $4, 10, 5) RETURNING id`,
      [teacherId, subjectId, status, JSON.stringify(config)],
    )) as [{ id: string }];
    return id;
  }

  async function seedSection(examId: string): Promise<string> {
    const [{ id }] = (await ctx.dataSource.query(
      `INSERT INTO exam_sections (id, exam_id, order_index) VALUES (gen_random_uuid(), $1, 0) RETURNING id`,
      [examId],
    )) as [{ id: string }];
    return id;
  }

  /** Seeds a bank question + attaches it to the exam with a full content/answer-key SNAPSHOT (bypasses the authoring service). */
  async function attachSingleChoice(
    teacherId: string,
    examId: string,
    sectionId: string,
    orderIndex: number,
    correctOptionId = 'opt_1',
  ): Promise<string> {
    const content = {
      prompt: { en: `Question ${String(orderIndex + 1)}` },
      options: [
        { id: 'opt_0', text: { en: 'A' } },
        { id: 'opt_1', text: { en: 'B' } },
        { id: 'opt_2', text: { en: 'C' } },
        { id: 'opt_3', text: { en: 'D' } },
      ],
    };
    const answerKey = { correctOptionId };
    const [{ id: questionId }] = (await ctx.dataSource.query(
      `INSERT INTO questions (id, teacher_id, subject_id, type, content, answer_key, default_marks)
       VALUES (gen_random_uuid(), $1, $2, 'single_choice', $3, $4, 5) RETURNING id`,
      [teacherId, subjectId, JSON.stringify(content), JSON.stringify(answerKey)],
    )) as [{ id: string }];
    const [{ id: examQuestionId }] = (await ctx.dataSource.query(
      `INSERT INTO exam_questions (id, exam_id, section_id, question_id, question_version, type_snapshot, content_snapshot, answer_key_snapshot, order_index, marks, weight, is_bonus, required)
       VALUES (gen_random_uuid(), $1, $2, $3, 1, 'single_choice', $4, $5, $6, 5, 1, false, true) RETURNING id`,
      [
        examId,
        sectionId,
        questionId,
        JSON.stringify(content),
        JSON.stringify(answerKey),
        orderIndex,
      ],
    )) as [{ id: string }];
    return examQuestionId;
  }

  async function attachTrueFalse(
    teacherId: string,
    examId: string,
    sectionId: string,
    orderIndex: number,
    correctValue = true,
  ): Promise<string> {
    const content = { prompt: { en: `TF Question ${String(orderIndex + 1)}` } };
    const answerKey = { value: correctValue };
    const [{ id: questionId }] = (await ctx.dataSource.query(
      `INSERT INTO questions (id, teacher_id, subject_id, type, content, answer_key, default_marks)
       VALUES (gen_random_uuid(), $1, $2, 'true_false', $3, $4, 5) RETURNING id`,
      [teacherId, subjectId, JSON.stringify(content), JSON.stringify(answerKey)],
    )) as [{ id: string }];
    const [{ id: examQuestionId }] = (await ctx.dataSource.query(
      `INSERT INTO exam_questions (id, exam_id, section_id, question_id, question_version, type_snapshot, content_snapshot, answer_key_snapshot, order_index, marks, weight, is_bonus, required)
       VALUES (gen_random_uuid(), $1, $2, $3, 1, 'true_false', $4, $5, $6, 5, 1, false, true) RETURNING id`,
      [
        examId,
        sectionId,
        questionId,
        JSON.stringify(content),
        JSON.stringify(answerKey),
        orderIndex,
      ],
    )) as [{ id: string }];
    return examQuestionId;
  }

  async function getTemplateLayout(templateId: string): Promise<OmrTemplateLayout> {
    const [{ layout }] = (await ctx.dataSource.query(
      `SELECT layout FROM omr_templates WHERE id = $1`,
      [templateId],
    )) as [{ layout: OmrTemplateLayout }];
    return layout;
  }

  function bubbleIndexFor(
    layout: OmrTemplateLayout,
    examQuestionId: string,
    optionId: string,
  ): number {
    const q = layout.questions.find((x) => x.examQuestionId === examQuestionId)!;
    return q.bubbles.findIndex((b) => b.kind === 'option' && b.optionId === optionId);
  }

  function trueFalseIndex(
    layout: OmrTemplateLayout,
    examQuestionId: string,
    value: boolean,
  ): number {
    const q = layout.questions.find((x) => x.examQuestionId === examQuestionId)!;
    return q.bubbles.findIndex((b) => b.kind === 'boolean' && b.value === value);
  }

  async function generateSheet(examId: string, studentId: string): Promise<SheetRow> {
    const res = await teacher.agent
      .post(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/generate`)
      .send({ student_ids: [studentId] })
      .expect(201);
    return (res.body as SheetRow[])[0]!;
  }

  async function uploadScan(examId: string, sheetId: string, image: Buffer): Promise<SheetRow> {
    const res = await teacher.agent
      .post(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets`)
      .field('sheet_id', sheetId)
      .attach('file', image, { filename: 'scan.png', contentType: 'image/png' })
      .expect(201);
    return res.body as SheetRow;
  }

  // ---------- tests ----------

  it('runs the full flow: generate → scan → recognize → review → confirm → graded attempt, and shows up in analytics', async () => {
    await grantInstructorRosterAccess(student.userId, teacher.userId);
    const examId = await seedExam(teacher.userId);
    const sectionId = await seedSection(examId);
    const q1 = await attachSingleChoice(teacher.userId, examId, sectionId, 0, 'opt_1');
    const q2 = await attachTrueFalse(teacher.userId, examId, sectionId, 1, true);

    const sheet = await generateSheet(examId, student.userId);
    expect(sheet.status).toBe('pending');

    const layout = await getTemplateLayout(sheet.template_id!);
    const image = await renderFixtureSheet({
      sheetId: sheet.id,
      template: layout,
      marks: {
        [q1]: [bubbleIndexFor(layout, q1, 'opt_1')],
        [q2]: [trueFalseIndex(layout, q2, true)],
      },
    });

    await uploadScan(examId, sheet.id, image);
    await processor.process({
      name: JOB_TYPES.EXAM.OMR_PROCESS_SHEET,
      data: { sheetId: sheet.id },
    } as never);

    const afterProcessing = await teacher.agent
      .get(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/${sheet.id}`)
      .expect(200);
    expect((afterProcessing.body as SheetRow).status).toBe('ready');

    const review = await teacher.agent
      .get(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/${sheet.id}/review`)
      .expect(200);
    const reviewAnswers = (
      review.body as { answers: { exam_question_id: string; status: string; detected: unknown }[] }
    ).answers;
    expect(reviewAnswers.find((a) => a.exam_question_id === q1)).toMatchObject({
      status: 'confident',
      detected: { optionId: 'opt_1' },
    });
    expect(reviewAnswers.find((a) => a.exam_question_id === q2)).toMatchObject({
      status: 'confident',
      detected: { value: true },
    });

    const confirmRes = await teacher.agent
      .post(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/${sheet.id}/confirm`)
      .expect(201);
    const confirmed = confirmRes.body as {
      sheet: SheetRow;
      attempt: { state: string; score_total: number };
    };
    expect(confirmed.sheet.status).toBe('completed');
    expect(confirmed.attempt.state).toBe('graded');
    expect(confirmed.attempt.score_total).toBe(10);

    const attemptRows = (await ctx.dataSource.query(
      `SELECT id, origin, state, score_total FROM exam_attempts WHERE exam_id = $1 AND student_id = $2`,
      [examId, student.userId],
    )) as { id: string; origin: string; state: string; score_total: string }[];
    expect(attemptRows).toHaveLength(1);
    expect(attemptRows[0]!.origin).toBe('omr');
    expect(attemptRows[0]!.state).toBe('graded');
    expect(Number(attemptRows[0]!.score_total)).toBe(10);

    const analytics = await teacher.agent
      .get(`${API_PREFIX}/analytics/exams/${examId}`)
      .expect(200);
    const analyticsBody = analytics.body as {
      data?: { total_submissions?: number; average_score?: number | null };
    };
    expect(analyticsBody.data?.total_submissions ?? 0).toBeGreaterThanOrEqual(1);
    expect(analyticsBody.data?.average_score).toBe(10);
  });

  it('leaves an unmarked question genuinely blank rather than guessing', async () => {
    await grantInstructorRosterAccess(student.userId, teacher.userId);
    const examId = await seedExam(teacher.userId);
    const sectionId = await seedSection(examId);
    const q1 = await attachSingleChoice(teacher.userId, examId, sectionId, 0, 'opt_1');
    const q2 = await attachTrueFalse(teacher.userId, examId, sectionId, 1, true);

    const sheet = await generateSheet(examId, student.userId);
    const layout = await getTemplateLayout(sheet.template_id!);
    const image = await renderFixtureSheet({
      sheetId: sheet.id,
      template: layout,
      marks: { [q1]: [bubbleIndexFor(layout, q1, 'opt_1')] }, // q2 left blank
    });

    await uploadScan(examId, sheet.id, image);
    await processor.process({
      name: JOB_TYPES.EXAM.OMR_PROCESS_SHEET,
      data: { sheetId: sheet.id },
    } as never);
    await teacher.agent
      .post(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/${sheet.id}/confirm`)
      .expect(201);

    const rows = (await ctx.dataSource.query(
      `SELECT eaa.response, eaa.score FROM exam_attempt_answers eaa
       JOIN exam_attempts ea ON ea.id = eaa.attempt_id
       WHERE ea.exam_id = $1 AND eaa.exam_question_id = $2`,
      [examId, q2],
    )) as { response: unknown; score: string }[];
    expect(rows[0]!.response).toBeNull();
    expect(Number(rows[0]!.score)).toBe(0);
  });

  it('flags multiple marks as review_required, blocks confirm until resolved, then grades the corrected answer', async () => {
    await grantInstructorRosterAccess(student.userId, teacher.userId);
    const examId = await seedExam(teacher.userId);
    const sectionId = await seedSection(examId);
    const q1 = await attachSingleChoice(teacher.userId, examId, sectionId, 0, 'opt_1');

    const sheet = await generateSheet(examId, student.userId);
    const layout = await getTemplateLayout(sheet.template_id!);
    const idxA = bubbleIndexFor(layout, q1, 'opt_0');
    const idxB = bubbleIndexFor(layout, q1, 'opt_1');
    const image = await renderFixtureSheet({
      sheetId: sheet.id,
      template: layout,
      marks: { [q1]: [idxA, idxB] },
    });

    await uploadScan(examId, sheet.id, image);
    await processor.process({
      name: JOB_TYPES.EXAM.OMR_PROCESS_SHEET,
      data: { sheetId: sheet.id },
    } as never);

    const afterProcessing = await teacher.agent
      .get(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/${sheet.id}`)
      .expect(200);
    expect((afterProcessing.body as SheetRow).status).toBe('review_required');

    await teacher.agent
      .post(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/${sheet.id}/confirm`)
      .expect(400);

    await teacher.agent
      .patch(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/${sheet.id}/answers/${q1}`)
      .send({ response: { optionId: 'opt_1' } })
      .expect(200);

    const confirmRes = await teacher.agent
      .post(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/${sheet.id}/confirm`)
      .expect(201);
    expect((confirmRes.body as { attempt: { score_total: number } }).attempt.score_total).toBe(5);
  });

  it('rejects a scan whose identity QR points at a different sheet (wrong template/mismatch)', async () => {
    await grantInstructorRosterAccess(student.userId, teacher.userId);
    const examId = await seedExam(teacher.userId);
    const sectionId = await seedSection(examId);
    await attachSingleChoice(teacher.userId, examId, sectionId, 0, 'opt_1');

    const [sheetA, sheetB] = await Promise.all([
      generateSheet(examId, student.userId),
      (async () => {
        const student2 = await createAuthenticatedUser(ctx.app, ctx.dataSource);
        await grantInstructorRosterAccess(student2.userId, teacher.userId);
        return generateSheet(examId, student2.userId);
      })(),
    ]);

    const layout = await getTemplateLayout(sheetA.template_id!);
    // Image's QR claims to be sheetA, but we upload it against sheetB's slot.
    const image = await renderFixtureSheet({ sheetId: sheetA.id, template: layout, marks: {} });

    await uploadScan(examId, sheetB.id, image);
    await processor.process({
      name: JOB_TYPES.EXAM.OMR_PROCESS_SHEET,
      data: { sheetId: sheetB.id },
    } as never);

    const result = await teacher.agent
      .get(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/${sheetB.id}`)
      .expect(200);
    expect((result.body as SheetRow).status).toBe('failed');
  });

  it('rejects a malformed image cleanly (FAILED, not a crash)', async () => {
    await grantInstructorRosterAccess(student.userId, teacher.userId);
    const examId = await seedExam(teacher.userId);
    const sectionId = await seedSection(examId);
    await attachSingleChoice(teacher.userId, examId, sectionId, 0, 'opt_1');
    const sheet = await generateSheet(examId, student.userId);

    // Valid JPEG magic bytes (passes upload-time signature check) followed by garbage (fails real decode).
    const corrupt = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from('not actually a jpeg stream'),
    ]);
    await teacher.agent
      .post(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets`)
      .field('sheet_id', sheet.id)
      .attach('file', corrupt, { filename: 'bad.jpg', contentType: 'image/jpeg' })
      .expect(201);

    await processor.process({
      name: JOB_TYPES.EXAM.OMR_PROCESS_SHEET,
      data: { sheetId: sheet.id },
    } as never);

    const result = await teacher.agent
      .get(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/${sheet.id}`)
      .expect(200);
    expect((result.body as SheetRow).status).toBe('failed');
  });

  it('rejects an unauthorized teacher (404, no ownership disclosure) from every OMR route', async () => {
    await grantInstructorRosterAccess(student.userId, teacher.userId);
    const examId = await seedExam(teacher.userId);
    const sectionId = await seedSection(examId);
    await attachSingleChoice(teacher.userId, examId, sectionId, 0, 'opt_1');
    const sheet = await generateSheet(examId, student.userId);

    await otherTeacher.agent
      .post(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/generate`)
      .send({ student_ids: [student.userId] })
      .expect(404);
    await otherTeacher.agent
      .get(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/${sheet.id}`)
      .expect(404);
    await otherTeacher.agent
      .post(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/${sheet.id}/confirm`)
      .expect(404);
  });

  it('lists sheets as a paginated {data, meta} envelope with the student name embedded (owner-only)', async () => {
    await grantInstructorRosterAccess(student.userId, teacher.userId);
    const examId = await seedExam(teacher.userId);
    const sectionId = await seedSection(examId);
    await attachSingleChoice(teacher.userId, examId, sectionId, 0, 'opt_1');
    const sheet = await generateSheet(examId, student.userId);

    const res = await teacher.agent
      .get(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets?page=1&limit=100`)
      .expect(200);
    const body = res.body as {
      data: Array<{ id: string; student_id: string; student: { id: string; name: string } | null }>;
      meta: { total: number; page: number; limit: number };
    };
    expect(body.meta.total).toBe(1);
    expect(body.meta.limit).toBe(100);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(sheet.id);
    expect(body.data[0]!.student_id).toBe(student.userId);
    expect(body.data[0]!.student?.id).toBe(student.userId);
    expect(typeof body.data[0]!.student?.name).toBe('string');
    // only id + name of the student are exposed
    expect(Object.keys(body.data[0]!.student!).sort()).toEqual(['id', 'name']);

    await otherTeacher.agent
      .get(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets`)
      .expect(404);
  });

  it('is idempotent under retry: confirming twice never creates a second Attempt', async () => {
    await grantInstructorRosterAccess(student.userId, teacher.userId);
    const examId = await seedExam(teacher.userId);
    const sectionId = await seedSection(examId);
    const q1 = await attachSingleChoice(teacher.userId, examId, sectionId, 0, 'opt_1');

    const sheet = await generateSheet(examId, student.userId);
    const layout = await getTemplateLayout(sheet.template_id!);
    const image = await renderFixtureSheet({
      sheetId: sheet.id,
      template: layout,
      marks: { [q1]: [bubbleIndexFor(layout, q1, 'opt_1')] },
    });
    await uploadScan(examId, sheet.id, image);
    await processor.process({
      name: JOB_TYPES.EXAM.OMR_PROCESS_SHEET,
      data: { sheetId: sheet.id },
    } as never);

    const first = await teacher.agent
      .post(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/${sheet.id}/confirm`)
      .expect(201);
    const second = await teacher.agent
      .post(`${API_PREFIX}/teacher/exams/${examId}/omr-sheets/${sheet.id}/confirm`)
      .expect(201);

    const firstAttemptId = (first.body as { attempt: { attempt_id: string } }).attempt.attempt_id;
    const secondAttemptId = (second.body as { attempt: { attempt_id: string } }).attempt.attempt_id;
    expect(secondAttemptId).toBe(firstAttemptId);

    const attemptRows = (await ctx.dataSource.query(
      `SELECT id FROM exam_attempts WHERE exam_id = $1 AND student_id = $2`,
      [examId, student.userId],
    )) as { id: string }[];
    expect(attemptRows).toHaveLength(1);
  });
});
