import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { DataSource } from 'typeorm';

import { QuizAnalyticsService } from '../../src/analytics/quiz-analytics.service';
import { AttendanceRecord } from '../../src/attendance/entities/attendance-record.entity';
import { Exam } from '../../src/exams/entities/exam.entity';
import { ExamAttempt } from '../../src/exams/entities/exam-attempt.entity';
import { ExamAttemptAnswer } from '../../src/exams/entities/exam-attempt-answer.entity';
import { ExamQuestion } from '../../src/exams/entities/exam-question.entity';
import { ExamSection } from '../../src/exams/entities/exam-section.entity';
import { Question } from '../../src/exams/entities/question.entity';
import { QuestionSolve } from '../../src/gamification/entities/question-solve.entity';
import { HomeworkSubmission } from '../../src/lessons/entities/homework-submission.entity';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { LessonHomework } from '../../src/lessons/entities/lesson-homework.entity';
import { LessonProgress } from '../../src/lessons/entities/lesson-progress.entity';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { createE2EApp, resetDatabase, type E2EContext } from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

/**
 * T058 parity. `quiz-analytics-parity.golden.json` was captured from the
 * implementation BEFORE the query-shape rewrite (UPDATE_QUIZ_GOLDEN=1 on that
 * code); the rewritten service must reproduce it byte-for-byte on a fixture that
 * carries every hidden filter: soft-deleted lesson / homework / exam / question /
 * teacher / subject, a suspicious solve, a non-graded submission, each review
 * policy, excused attendance, zero-max answers and equal timestamps.
 * Only wall-clock-free values are compared (all dates are explicit).
 */
const GOLDEN = path.join(__dirname, 'fixtures', 'quiz-analytics-parity.golden.json');

describe('Student quiz analytics parity (postgres)', () => {
  let ctx: E2EContext;
  let service: QuizAnalyticsService;
  let counter: StatementCounter;

  beforeAll(async () => {
    ctx = await createE2EApp();
    service = ctx.app.get(QuizAnalyticsService);
    counter = new StatementCounter(ctx.dataSource);
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const ds = (): DataSource => ctx.dataSource;
  const at = (day: number, hour = 10, minute = 0): Date =>
    new Date(Date.UTC(2026, 0, day, hour, minute, 0));

  async function user(role: UserRole, tag: string, deleted = false): Promise<User> {
    const users = ds().getRepository(User);
    const saved = await users.save(
      users.create({
        username: `qa-${tag}`,
        name: `QA ${tag}`,
        first_name: null,
        last_name: null,
        email: `qa-${tag}@example.test`,
        phone: `0112${Math.floor(1_000_000 + Math.random() * 8_999_999).toString()}`,
        role,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    if (deleted) await users.softDelete({ id: saved.id });
    return saved;
  }

  async function subject(name: string, deleted = false): Promise<Subject> {
    const subjects = ds().getRepository(Subject);
    const saved = await subjects.save(
      subjects.create({
        name,
        description: null,
        description_ar: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
    if (deleted) await subjects.softDelete({ id: saved.id });
    return saved;
  }

  async function lesson(teacherId: string, subjectId: string, title: string, deleted = false) {
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

  async function question(teacherId: string, subjectId: string, deleted = false): Promise<Question> {
    const questions = ds().getRepository(Question);
    const saved = await questions.save(
      questions.create({
        teacher_id: teacherId,
        subject_id: subjectId,
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
    if (deleted) await questions.softDelete({ id: saved.id });
    return saved;
  }

  async function exam(
    teacherId: string,
    subjectId: string,
    title: string,
    config: Record<string, unknown>,
    deleted = false,
  ): Promise<{ exam: Exam; section: ExamSection }> {
    const exams = ds().getRepository(Exam);
    const saved = await exams.save(
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
        config,
        total_marks: 10,
        passing_marks: 5,
      } as never) as unknown as Exam,
    );
    const sections = ds().getRepository(ExamSection);
    const section = await sections.save(
      sections.create({
        exam_id: saved.id,
        order_index: 0,
        title: null,
        title_ar: null,
        description: null,
        description_ar: null,
        shuffle_questions: false,
      }),
    );
    if (deleted) await exams.softDelete({ id: saved.id });
    return { exam: saved, section };
  }

  async function attempt(
    examId: string,
    studentId: string,
    n: number,
    options: {
      state?: string;
      score?: number | null;
      max?: number;
      passed?: boolean | null;
      submit: Date;
      graded: Date | null;
    },
  ): Promise<ExamAttempt> {
    const attempts = ds().getRepository(ExamAttempt);
    return attempts.save(
      attempts.create({
        exam_id: examId,
        student_id: studentId,
        attempt_number: n,
        state: (options.state ?? 'graded') as never,
        shuffle_seed: 0,
        started_at: new Date(options.submit.getTime() - 20 * 60_000),
        deadline_at: new Date(options.submit.getTime() + 60 * 60_000),
        submitted_at: options.submit,
        auto_submitted: false,
        graded_at: options.graded,
        score_auto: options.score ?? null,
        score_manual: 0,
        score_total: options.score ?? null,
        max_score: options.max ?? 10,
        passed: options.passed ?? null,
        session_token: randomUUID(),
        idempotency_key: null,
        origin: 'online',
        created_at: options.submit,
        updated_at: options.submit,
      } as never) as unknown as ExamAttempt,
    );
  }

  async function answer(
    attemptRow: ExamAttempt,
    section: ExamSection,
    q: Question,
    type: string,
    score: number | null,
    max: number,
    updatedAt: Date,
    feedback: string | null = null,
  ): Promise<void> {
    const examQuestions = ds().getRepository(ExamQuestion);
    const eq = await examQuestions.save(
      examQuestions.create({
        exam_id: attemptRow.exam_id,
        section_id: section.id,
        question_id: q.id,
        question_version: 1,
        type_snapshot: type,
        content_snapshot: {},
        answer_key_snapshot: {},
        order_index: 0,
        marks: 1,
        weight: 1,
        is_bonus: false,
        required: true,
      } as never) as unknown as ExamQuestion,
    );
    const answers = ds().getRepository(ExamAttemptAnswer);
    const saved = await answers.save(
      answers.create({
        attempt_id: attemptRow.id,
        exam_question_id: eq.id,
        question_id: q.id,
        question_version: 1,
        order_index: 0,
        response: null,
        score,
        max_score: max,
        auto_graded: true,
        manual_required: false,
        is_correct: null,
        graded_by: null,
        feedback,
        ai_suggested_score: null,
        ai_confidence: null,
        answered_at: null,
        time_spent_ms: 0,
      } as never) as unknown as ExamAttemptAnswer,
    );
    await ds().query('UPDATE exam_attempt_answers SET updated_at = $1, created_at = $1 WHERE id = $2', [
      updatedAt,
      saved.id,
    ]);
  }

  async function seed() {
    const t1 = await user(UserRole.TEACHER, 't1');
    const t2 = await user(UserRole.TEACHER, 't2');
    const t3 = await user(UserRole.TEACHER, 't3-deleted', true);
    const student = await user(UserRole.STUDENT, 'student');
    const other = await user(UserRole.STUDENT, 'other');
    const A = await subject('Algebra');
    const B = await subject('Biology');
    const gone = await subject('Retired subject', true);

    const la1 = await lesson(t1.id, A.id, 'A1');
    const la2 = await lesson(t1.id, A.id, 'A2');
    const la3 = await lesson(t1.id, A.id, 'A3');
    const la4 = await lesson(t1.id, A.id, 'A4');
    const lb1 = await lesson(t2.id, B.id, 'B1');
    const ldel = await lesson(t1.id, A.id, 'A-deleted', true);

    const qa = await question(t1.id, A.id);
    const qb = await question(t2.id, B.id);
    const qdel = await question(t1.id, A.id, true);

    const noReview = { review_policy: 'after_graded' };
    const e1 = await exam(t1.id, A.id, 'E1 after graded', noReview);
    const e2 = await exam(t2.id, B.id, 'E2 never', { review_policy: 'never' });
    const e3 = await exam(t1.id, A.id, 'E3 after close (closed)', {
      review_policy: 'after_close',
      end_window_at: at(2).toISOString(),
    });
    const e4 = await exam(t1.id, A.id, 'E4 after close (open)', {
      review_policy: 'after_close',
      end_window_at: '2999-01-01T00:00:00.000Z',
    });
    const e5 = await exam(t1.id, A.id, 'E5 deleted exam', noReview, true);
    const e6 = await exam(t1.id, gone.id, 'E6 deleted subject', noReview);
    const e7 = await exam(t3.id, A.id, 'E7 deleted teacher', noReview);

    // Equal timestamps on purpose: ordering must not depend on tie-breaking quirks.
    const same = at(10, 9, 0);
    const a1 = await attempt(e1.exam.id, student.id, 1, { score: 8, passed: true, submit: at(5), graded: at(6) });
    const a1b = await attempt(e1.exam.id, student.id, 2, { score: 3, passed: false, submit: at(8), graded: same });
    const a2 = await attempt(e2.exam.id, student.id, 1, { score: 9, passed: true, submit: at(5), graded: at(6) });
    const a3 = await attempt(e3.exam.id, student.id, 1, { score: 6, passed: true, submit: at(4), graded: same });
    const a4 = await attempt(e4.exam.id, student.id, 1, { score: 7, passed: true, submit: at(4), graded: at(7) });
    const a5 = await attempt(e5.exam.id, student.id, 1, { score: 5, passed: true, submit: at(4), graded: at(7) });
    const a6 = await attempt(e6.exam.id, student.id, 1, { score: 4, passed: false, submit: at(9), graded: at(11) });
    const a7 = await attempt(e7.exam.id, student.id, 1, { score: 10, passed: true, submit: at(12), graded: at(13) });
    await attempt(e1.exam.id, student.id, 3, { state: 'in_progress', score: null, submit: at(14), graded: null });
    await attempt(e1.exam.id, student.id, 4, { score: 0, max: 0, passed: null, submit: at(15), graded: at(16) });
    await attempt(e1.exam.id, other.id, 1, { score: 10, passed: true, submit: at(5), graded: at(6) }); // another student

    const sections = {
      [e1.exam.id]: e1.section,
      [e3.exam.id]: e3.section,
      [e6.exam.id]: e6.section,
      [e7.exam.id]: e7.section,
    };
    // exam_questions is unique per (exam, question): every answer gets its own question row,
    // copying the template's owner/subject and its soft-deleted state.
    const ans = async (row: ExamAttempt, q: Question, type: string, score: number | null, max: number, day: number, fb: string | null = null) => {
      const fresh = await question(q.teacher_id, q.subject_id, q === qdel);
      await answer(row, sections[row.exam_id] ?? e1.section, fresh, type, score, max, at(day, 12), fb);
    };
    // Subject A gets >= 5 exam observations (mastery threshold) from visible attempts.
    await ans(a1, qa, 'single_choice', 4, 5, 6, 'well done');
    await ans(a1, qa, 'essay', 2, 5, 6, '  needs detail  ');
    await ans(a1b, qa, 'single_choice', 1, 5, 10);
    await ans(a1b, qa, 'true_false', 2, 5, 10, '');
    await ans(a3, qa, 'single_choice', 3, 3, 10);
    await ans(a3, qa, 'single_choice', 3, 3, 10);
    await ans(a1, qa, 'single_choice', 0, 0, 6); // max 0 -> skipped
    await ans(a1, qa, 'single_choice', null, 5, 6); // ungraded -> skipped
    await ans(a1, qdel, 'single_choice', 5, 5, 6); // soft-deleted question -> skipped
    await ans(a2, qb, 'single_choice', 5, 5, 6); // NEVER policy -> invisible
    await ans(a4, qa, 'single_choice', 5, 5, 7); // open AFTER_CLOSE -> invisible
    await ans(a5, qa, 'single_choice', 5, 5, 7); // deleted exam
    await ans(a6, qa, 'single_choice', 4, 4, 11);
    await ans(a7, qa, 'single_choice', 4, 4, 13);

    // Practice (subject-scoped): one suspicious solve is excluded.
    const solves = ds().getRepository(QuestionSolve);
    const solve = async (subjectId: string, q: Question, correct: boolean, createdAt: Date, suspicious = false) => {
      // unique per (user, question): a fresh question per solve
      const fresh = await question(q.teacher_id, q.subject_id);
      return solves.save(
        solves.create({
          user_id: student.id,
          question_id: fresh.id,
          question_version: 1,
          subject_id: subjectId,
          lesson_id: null,
          difficulty: 'easy',
          response: null,
          is_correct: correct,
          time_ms: 100,
          xp_awarded: 0,
          rating_delta: 0,
          combo_at_time: 0,
          first_solve: false,
          suspicious,
          session_id: null,
          created_at: createdAt,
        } as never),
      );
    };
    for (let i = 0; i < 5; i += 1) await solve(B.id, qb, i % 2 === 0, same); // 5 equal timestamps
    await solve(B.id, qb, true, at(3), true);
    await solve(A.id, qa, true, at(3));

    // Homework: graded live, graded on a soft-deleted homework, on a soft-deleted lesson, non-graded.
    const homeworks = ds().getRepository(LessonHomework);
    const hw = async (lessonId: string, deleted = false) => {
      const saved = await homeworks.save(
        homeworks.create({
          lesson_id: lessonId,
          title: 'hw',
          title_ar: null,
          description: null,
          description_ar: null,
          type: 'text',
          resource_url: null,
          resource_filename: null,
          due_at: null,
          questions: [],
          max_score: 20,
          published_at: null,
        } as never) as unknown as LessonHomework,
      );
      if (deleted) await homeworks.softDelete({ id: saved.id });
      return saved;
    };
    const live = await hw(la1.id);
    const live2 = await hw(la1.id);
    const live3 = await hw(la2.id); // submitted, never graded
    const deletedHw = await hw(la1.id, true);
    const onDeletedLesson = await hw(ldel.id);
    const subs = ds().getRepository(HomeworkSubmission);
    const sub = (h: LessonHomework, status: string, score: number | null, gradedAt: Date | null) =>
      subs.save(
        subs.create({
          homework_id: h.id,
          student_id: student.id,
          answer_text: null,
          answers: [],
          resource_url: null,
          resource_filename: null,
          status: status as never,
          is_late: false,
          score,
          feedback: null,
          submitted_at: at(3),
          graded_at: gradedAt,
          graded_by: null,
        } as never),
      );
    await sub(live, 'graded', 15, at(6));
    await sub(live2, 'graded', 18, same);
    await sub(deletedHw, 'graded', 20, at(6));
    await sub(onDeletedLesson, 'graded', 20, at(6));
    await sub(live3, 'submitted', null, null);

    // Lesson progress / attendance, incl. rows on a soft-deleted lesson.
    const progress = ds().getRepository(LessonProgress);
    const prog = (l: Lesson, percent: number, completed: boolean, watched: Date) =>
      progress.save(
        progress.create({
          student_id: student.id,
          lesson_id: l.id,
          watched_duration: 0,
          total_duration: 600,
          progress_percent: percent,
          completed,
          completed_at: completed ? watched : null,
          last_watched_at: watched,
        } as never),
      );
    await prog(la1, 100, true, at(5));
    await prog(la2, 40, false, at(6));
    await prog(lb1, 250, false, at(7)); // clamped to 100
    await prog(ldel, 90, true, at(5)); // soft-deleted lesson: skipped
    const attendance = ds().getRepository(AttendanceRecord);
    const att = (l: Lesson, status: string, markedAt: Date) =>
      attendance.save(
        attendance.create({
          student_id: student.id,
          lesson_id: l.id,
          scheduled_lesson_session_id: null,
          status: status as never,
          marked_by: null,
          is_auto_marked: false,
          notes: null,
          marked_at: markedAt,
        } as never),
      );
    await att(la1, 'present', at(5));
    await att(la2, 'late', at(6));
    await att(la3, 'absent', at(7));
    await att(la4, 'excused', at(8));
    await att(lb1, 'present', at(9));
    await att(ldel, 'present', at(5)); // soft-deleted lesson: skipped
    return { student, A, B, t1, t2 };
  }

  /** Bypasses the (owner-keyed) cache so each variant is computed afresh. */
  const compute = (studentId: string, filter: Record<string, string>) =>
    (
      service as unknown as {
        computeStudentAnalytics: (id: string, f: Record<string, string>) => Promise<unknown>;
      }
    ).computeStudentAnalytics(studentId, filter);

  it('reproduces the pre-rewrite JSON on every filter variant', async () => {
    const { student, A, B, t1 } = await seed();
    const variants: Record<string, Record<string, string>> = {
      none: {},
      subjectA: { subjectId: A.id },
      subjectB: { subjectId: B.id },
      teacherT1: { teacherId: t1.id },
      range: { from: at(4).toISOString(), to: at(9, 23).toISOString() },
      rangeAndSubject: { from: at(5).toISOString(), to: at(12).toISOString(), subjectId: A.id },
    };
    const actual: Record<string, unknown> = {};
    for (const [name, filter] of Object.entries(variants)) {
      actual[name] = JSON.parse(JSON.stringify(await compute(student.id, filter)));
    }

    if (process.env['UPDATE_QUIZ_GOLDEN'] === '1') {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
    expect(actual).toEqual(golden);
    // Fixture sanity: not an all-empty comparison.
    const none = actual['none'] as { totalAttempts: number; attempts: unknown[]; strongTopics: unknown[]; performanceByQuestionType: unknown[] };
    expect(none.totalAttempts).toBeGreaterThan(3);
    expect(none.performanceByQuestionType.length).toBeGreaterThan(0);
  });

  it('T062: view=summary equals the same two fields of the full response on every variant, in one statement', async () => {
    const { student, A, B, t1 } = await seed();
    const variants: Record<string, Record<string, string>> = {
      none: {},
      subjectA: { subjectId: A.id },
      subjectB: { subjectId: B.id },
      teacherT1: { teacherId: t1.id },
      range: { from: at(4).toISOString(), to: at(9, 23).toISOString() },
    };
    const summaryOf = (filter: Record<string, string>) =>
      (
        service as unknown as {
          computeStudentSummary: (id: string, f: Record<string, string>) => Promise<unknown>;
        }
      ).computeStudentSummary(student.id, filter);
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<
      string,
      { totalAttempts: number; averageScore: number }
    >;
    for (const [name, filter] of Object.entries(variants)) {
      const expected = golden[name] as { totalAttempts: number; averageScore: number };
      counter.start();
      const summary = await summaryOf(filter);
      expect(counter.stop().length).toBe(1);
      expect(summary).toEqual({
        totalAttempts: expected.totalAttempts,
        averageScore: expected.averageScore,
      });
    }
  });

  it('statement counts: 7 without a teacher filter, 3 with one', async () => {
    const { student, t1 } = await seed();
    counter.start();
    await compute(student.id, {});
    const full = counter.stop().length;
    counter.start();
    await compute(student.id, { teacherId: t1.id });
    const teacher = counter.stop().length;
    // Baseline (pre-rewrite): 7 and 7. A teacher filter now skips the four history statements.
    expect(full).toBe(7);
    expect(teacher).toBe(3);
  });
});
