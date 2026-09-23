import { randomInt, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, In, LessThan, Repository } from 'typeorm';

import { ApplicationCacheService } from '../../common/cache/application-cache.service';
import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { biBody } from '../../i18n/error-translator.util';
import { SaveAnswersDto, SubmitAttemptDto } from '../dto';
import {
  AttemptState,
  Exam,
  ExamAttempt,
  ExamAttemptAnswer,
  ExamConfig,
  ExamQuestion,
  ExamSection,
  ExamStatus,
  QuestionResponsePayload,
  ReviewPolicy,
} from '../entities';
import { QuestionTypeRegistry } from '../question-types/question-type-registry';
import { AttemptGradingService } from './attempt-grading.service';
import {
  studentExamCacheScopes,
  studentQuizCacheScopes,
  teacherExamCacheScopes,
  teacherQuizCacheScopes,
} from './exam-cache-scopes';
import { ExamAccessService } from './exam-access.service';
import { ExamGradedPublisher } from './exam-graded-publisher.service';
import { ExamJobsService } from './exam-jobs.service';
import { deriveSeed, seededShuffle } from './shuffle.util';

// Either unique index can fire on a concurrent start: the partial "one open
// attempt" guard, or the (exam, student, attempt_number) composite when two
// requests race to create attempt number N. Both mean "an attempt already exists".
const ATTEMPT_CONFLICT_CONSTRAINTS = new Set([
  'UQ_exam_attempts_open_per_student',
  'UQ_exam_attempts_exam_student_number',
]);

/** A question as rendered to a student (never carries the answer key). */
export interface RenderedQuestion {
  exam_question_id: string;
  section_id: string;
  order: number;
  type: string;
  marks: number;
  is_bonus: boolean;
  content: Record<string, unknown>;
  saved_response: QuestionResponsePayload | null;
}

export interface RenderedAttempt {
  attempt_id: string;
  exam_id: string;
  state: AttemptState;
  session_token: string;
  started_at: Date;
  deadline_at: Date;
  server_time: Date;
  remaining_seconds: number;
  total_marks: number;
  sections: Array<{
    id: string;
    order: number;
    title: string | null;
    title_ar: string | null;
    description: string | null;
  }>;
  questions: RenderedQuestion[];
}

export interface SubmissionSummary {
  attempt_id: string;
  state: AttemptState;
  auto_submitted: boolean;
  score_auto: number | null;
  score_total: number | null;
  max_score: number;
  passed: boolean | null;
  pending_manual: number;
  submitted_at: Date | null;
}

@Injectable()
export class AttemptService {
  private readonly logger = new Logger(AttemptService.name);

  constructor(
    @InjectRepository(Exam) private readonly exams: Repository<Exam>,
    @InjectRepository(ExamQuestion) private readonly examQuestions: Repository<ExamQuestion>,
    @InjectRepository(ExamAttempt) private readonly attempts: Repository<ExamAttempt>,
    @InjectRepository(ExamAttemptAnswer) private readonly answers: Repository<ExamAttemptAnswer>,
    private readonly dataSource: DataSource,
    private readonly gradingOrchestrator: AttemptGradingService,
    private readonly jobs: ExamJobsService,
    private readonly access: ExamAccessService,
    private readonly examGradedPublisher: ExamGradedPublisher,
    private readonly questionTypes: QuestionTypeRegistry,
    private readonly applicationCache: ApplicationCacheService,
  ) {}

  // ==================== START / RESUME ====================

  public async startAttempt(studentId: string, examId: string): Promise<RenderedAttempt> {
    const exam = await this.access.findAccessibleExam(studentId, examId);
    this.assertOpen(exam);

    // Resume an existing in-progress attempt rather than creating a second one.
    const inProgress = await this.attempts.findOne({
      where: { exam_id: examId, student_id: studentId, state: AttemptState.IN_PROGRESS },
    });
    if (inProgress) {
      return this.renderAttempt(await this.finalizeIfExpired(inProgress));
    }

    const priorAttempts = await this.attempts.count({
      where: { exam_id: examId, student_id: studentId },
    });
    if (priorAttempts >= exam.config.attempts_allowed) {
      throw new ConflictException(
        biBody(
          'You have used all of your attempts for this exam',
          'لقد استنفدت جميع محاولاتك المتاحة لهذا الاختبار',
        ),
      );
    }

    const examQuestions = await this.examQuestions.find({ where: { exam_id: examId } });
    if (examQuestions.length === 0) {
      throw new BadRequestException(
        biBody('This exam has no questions', 'لا يحتوي هذا الاختبار على أي أسئلة'),
      );
    }

    const now = new Date();
    const deadline = new Date(now.getTime() + exam.config.duration_seconds * 1000);
    const seed = randomInt(1, 2 ** 31 - 1);

    let attempt: ExamAttempt;
    try {
      attempt = await retryTransaction(this.dataSource, async (manager) => {
        const created = manager.create(ExamAttempt, {
          exam_id: examId,
          student_id: studentId,
          attempt_number: priorAttempts + 1,
          state: AttemptState.IN_PROGRESS,
          shuffle_seed: seed,
          started_at: now,
          deadline_at: deadline,
          max_score: exam.total_marks,
          session_token: randomUUID(),
        });
        const savedAttempt = await manager.save(ExamAttempt, created);

        // Pre-create one answer row per question so autosave is a simple update
        // and the attempt's question set is fixed at start time.
        const ordered = this.orderQuestions(examQuestions, exam.config, seed);
        const rows = ordered.map((eq, index) =>
          manager.create(ExamAttemptAnswer, {
            attempt_id: savedAttempt.id,
            exam_question_id: eq.id,
            question_id: eq.question_id,
            question_version: eq.question_version,
            order_index: index,
            response: null,
            max_score: eq.marks,
          }),
        );
        await manager.save(ExamAttemptAnswer, rows);
        return savedAttempt;
      });
    } catch (err) {
      if (this.isOpenAttemptConflict(err)) {
        // Concurrent start — reuse the attempt the winning request created.
        const existing = await this.attempts.findOne({
          where: { exam_id: examId, student_id: studentId, state: AttemptState.IN_PROGRESS },
        });
        if (existing) return this.renderAttempt(existing);
        throw new ConflictException(
          biBody('An attempt is already in progress', 'توجد محاولة قيد التقدم بالفعل'),
        );
      }
      throw err;
    }

    // The new attempt is committed: refresh this student's and the exam owner's
    // cached slices before any queue call below can fail the request.
    // A new attempt is IN_PROGRESS, which teacher quiz analytics ignore, so that family is not touched.
    await this.invalidateAttemptCaches(studentId, exam.teacher_id, false);

    // Server-authoritative auto-submit: a delayed job finalises the attempt when
    // the deadline (+ grace) elapses, even if the client never returns.
    const delayMs = exam.config.duration_seconds * 1000 + exam.config.grace_seconds * 1000;
    await this.jobs.scheduleAutoSubmit(attempt.id, delayMs);

    this.logger.log(`Attempt ${attempt.id} started for student ${studentId} on exam ${examId}`);
    return this.renderAttempt(attempt);
  }

  /**
   * Find-or-create an attempt for a server-triggered (non-interactive) grading
   * path (currently: OMR confirm). Deliberately skips `jobs.scheduleAutoSubmit`,
   * since the caller finalises this attempt synchronously moments later (a
   * delayed job that would only ever be cancelled is wasted work).
   *
   * Idempotent for its OWN prior attempts (returns an existing `origin:'omr'`
   * attempt — in progress or already finalised — as-is rather than
   * duplicating), but will NOT silently adopt an attempt it didn't create:
   * if a student already has ANY attempt for this exam whose `origin` isn't
   * `'omr'` (a genuine live online session, or a prior online result,
   * regardless of state), this throws a 409 rather than hijacking or
   * discarding it — `ExamAttempt` has no per-exam multi-attempt policy wired
   * into this path, so "any pre-existing non-OMR attempt blocks OMR" is the
   * conservative, safe default. The caller sees this as an immediate,
   * synchronous conflict at confirm-time rather than a silently-discarded
   * scan sheet.
   */
  public async createOmrAttempt(examId: string, studentId: string): Promise<ExamAttempt> {
    await this.access.assertCanAccessPrivateExam(studentId, examId);
    const existing = await this.attempts.findOne({
      where: { exam_id: examId, student_id: studentId },
      order: { attempt_number: 'DESC' },
    });
    if (existing) {
      if (existing.origin !== 'omr') {
        throw new ConflictException(
          biBody(
            'This student already has an existing exam attempt for this exam',
            'يوجد للطالب بالفعل محاولة سابقة لهذا الاختبار',
          ),
        );
      }
      return existing;
    }

    const exam = await this.exams.findOneOrFail({ where: { id: examId } });
    const examQuestions = await this.examQuestions.find({ where: { exam_id: examId } });
    if (examQuestions.length === 0) {
      throw new BadRequestException(
        biBody('This exam has no questions', 'لا يحتوي هذا الاختبار على أي أسئلة'),
      );
    }

    const now = new Date();
    const deadline = new Date(now.getTime() + exam.config.duration_seconds * 1000);
    const seed = randomInt(1, 2 ** 31 - 1);

    try {
      return await retryTransaction(this.dataSource, async (manager) => {
        const created = manager.create(ExamAttempt, {
          exam_id: examId,
          student_id: studentId,
          attempt_number: 1,
          state: AttemptState.IN_PROGRESS,
          shuffle_seed: seed,
          started_at: now,
          deadline_at: deadline,
          max_score: exam.total_marks,
          session_token: randomUUID(),
          origin: 'omr',
        });
        const savedAttempt = await manager.save(ExamAttempt, created);

        const ordered = this.orderQuestions(examQuestions, exam.config, seed);
        const rows = ordered.map((eq, index) =>
          manager.create(ExamAttemptAnswer, {
            attempt_id: savedAttempt.id,
            exam_question_id: eq.id,
            question_id: eq.question_id,
            question_version: eq.question_version,
            order_index: index,
            response: null,
            max_score: eq.marks,
          }),
        );
        await manager.save(ExamAttemptAnswer, rows);
        return savedAttempt;
      });
    } catch (err) {
      if (this.isOpenAttemptConflict(err)) {
        // Concurrent OMR confirm for the same (exam, student) — reuse whichever won the race.
        const raced = await this.attempts.findOne({
          where: { exam_id: examId, student_id: studentId },
          order: { attempt_number: 'DESC' },
        });
        if (raced) return raced;
      }
      throw err;
    }
  }

  /** Resume/get an attempt (lazily finalises if the deadline already passed). */
  public async getAttempt(studentId: string, attemptId: string): Promise<RenderedAttempt> {
    const attempt = await this.loadOwnedAttempt(studentId, attemptId);
    await this.access.assertCanAccessExam(studentId, attempt.exam_id);
    return this.renderAttempt(await this.finalizeIfExpired(attempt));
  }

  /**
   * Read-only summary for an attempt that was finalised elsewhere (e.g. an
   * OMR sheet whose `confirm()` call is replaying idempotently against an
   * already-graded attempt) — the same accurate `pending_manual` computation
   * `finalize()` uses for its own already-finalised branch, without
   * re-running any grading.
   */
  public async getSummary(attemptId: string): Promise<SubmissionSummary | null> {
    const attempt = await this.attempts.findOne({ where: { id: attemptId } });
    if (!attempt) return null;
    const answers = await this.answers.find({ where: { attempt_id: attemptId } });
    return this.toSummary(attempt, answers);
  }

  // ==================== AUTOSAVE ====================

  public async saveAnswers(
    studentId: string,
    attemptId: string,
    dto: SaveAnswersDto,
  ): Promise<{ saved: number; state: AttemptState }> {
    const attempt = await this.loadOwnedAttempt(studentId, attemptId);
    await this.access.assertCanAccessExam(studentId, attempt.exam_id);
    if (attempt.state !== AttemptState.IN_PROGRESS) {
      throw new ConflictException(
        biBody(
          `Attempt is ${attempt.state}; answers can no longer be saved`,
          `المحاولة في حالة ${attempt.state}؛ لم يعد بالإمكان حفظ الإجابات`,
        ),
      );
    }
    const exam = await this.exams.findOneOrFail({ where: { id: attempt.exam_id } });
    if (this.isExpired(attempt, exam.config)) {
      await this.finalizeIfExpired(attempt);
      throw new ConflictException(
        biBody(
          'Time is up; the attempt has been submitted automatically',
          'انتهى الوقت؛ تم إرسال المحاولة تلقائيًا',
        ),
      );
    }

    const rows = await this.answers.find({ where: { attempt_id: attemptId } });
    const byExamQuestion = new Map(rows.map((r) => [r.exam_question_id, r]));
    const questions = await this.examQuestions.find({
      where: { id: In([...byExamQuestion.keys()]) },
    });
    const questionByExamQuestion = new Map(questions.map((question) => [question.id, question]));

    let saved = 0;
    const now = new Date();
    const toSave: ExamAttemptAnswer[] = [];
    for (const item of dto.answers) {
      const row = byExamQuestion.get(item.exam_question_id);
      if (!row) continue; // not part of this attempt → ignore
      this.assertValidResponse(questionByExamQuestion.get(row.exam_question_id), item.response);
      row.response = item.response ?? null;
      row.answered_at = item.response !== null && item.response !== undefined ? now : null;
      if (item.time_spent_ms !== undefined) row.time_spent_ms += item.time_spent_ms;
      toSave.push(row);
      saved++;
    }
    if (toSave.length > 0) await this.answers.save(toSave);
    return { saved, state: attempt.state };
  }

  // ==================== SUBMIT / FINALIZE ====================

  public async submit(
    studentId: string,
    attemptId: string,
    dto: SubmitAttemptDto,
  ): Promise<SubmissionSummary> {
    const attempt = await this.loadOwnedAttempt(studentId, attemptId);
    await this.access.assertCanAccessExam(studentId, attempt.exam_id);
    return this.finalize(attempt.id, { auto: false, submitDto: dto });
  }

  /** Invoked by the auto-submit worker when a deadline elapses. */
  public async finalizeExpired(attemptId: string): Promise<SubmissionSummary | null> {
    const attempt = await this.attempts.findOne({ where: { id: attemptId } });
    if (!attempt || attempt.state !== AttemptState.IN_PROGRESS) return null;
    return this.finalize(attemptId, { auto: true });
  }

  /**
   * Repeatable safety-net sweep (runs every minute — see `ExamJobsService`):
   * finds IN_PROGRESS attempts whose deadline has passed and finalises them.
   * This is a backstop for the primary per-attempt delayed job (e.g. if Redis
   * or the worker was down when that job would have fired) — it is never the
   * only path, so it must be exactly as safe to run redundantly. It routes
   * every recovered attempt through the same `finalizeExpired` → `finalize`
   * path (pessimistic-locked, idempotent), so a sweep racing the primary job,
   * or two sweep ticks racing each other, can never double-grade.
   */
  public async sweepExpiredAttempts(): Promise<{ scanned: number; recovered: string[] }> {
    const candidates = await this.attempts.find({
      where: { state: AttemptState.IN_PROGRESS, deadline_at: LessThan(new Date()) },
    });
    if (candidates.length === 0) return { scanned: 0, recovered: [] };

    const exams = await this.exams.find({
      where: { id: In([...new Set(candidates.map((a) => a.exam_id))]) },
    });
    const examById = new Map(exams.map((e) => [e.id, e]));

    const recovered: string[] = [];
    for (const attempt of candidates) {
      const exam = examById.get(attempt.exam_id);
      if (!exam || !this.isExpired(attempt, exam.config)) continue; // still within grace
      const summary = await this.finalizeExpired(attempt.id);
      if (summary) recovered.push(attempt.id);
    }
    return { scanned: candidates.length, recovered };
  }

  private async finalizeIfExpired(attempt: ExamAttempt): Promise<ExamAttempt> {
    if (attempt.state !== AttemptState.IN_PROGRESS) return attempt;
    const exam = await this.exams.findOneOrFail({ where: { id: attempt.exam_id } });
    if (!this.isExpired(attempt, exam.config)) return attempt;
    await this.finalize(attempt.id, { auto: true });
    return this.attempts.findOneOrFail({ where: { id: attempt.id } });
  }

  /**
   * The single, transactional, idempotent finalisation path (manual submit and
   * auto-submit both funnel through here). Pessimistically locks the attempt so
   * concurrent submits/auto-submit cannot double-grade.
   */
  private async finalize(
    attemptId: string,
    options: { auto: boolean; submitDto?: SubmitAttemptDto },
  ): Promise<SubmissionSummary> {
    const { summary, examId, manualAnswerIds, owners } = await retryTransaction(
      this.dataSource,
      async (manager) => {
        const attempt = await manager.findOne(ExamAttempt, {
          where: { id: attemptId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!attempt)
          throw new NotFoundException(biBody('Attempt not found', 'المحاولة غير موجودة'));

        // Idempotent: already finalised → return the current summary, no re-grade.
        if (attempt.state !== AttemptState.IN_PROGRESS) {
          const existing = await manager.find(ExamAttemptAnswer, {
            where: { attempt_id: attempt.id },
          });
          return {
            summary: this.toSummary(attempt, existing),
            examId: attempt.exam_id,
            manualAnswerIds: [] as string[],
            // Nothing was written, so nothing to invalidate.
            owners: null as { studentId: string; teacherId: string } | null,
          };
        }

        const exam = await manager.findOneOrFail(Exam, { where: { id: attempt.exam_id } });
        const answers = await manager.find(ExamAttemptAnswer, {
          where: { attempt_id: attempt.id },
        });
        const examQuestions = await manager.find(ExamQuestion, {
          where: { exam_id: attempt.exam_id },
        });
        const eqById = new Map(examQuestions.map((eq) => [eq.id, eq]));

        // Flush a final batch of answers supplied with the submit call.
        if (!options.auto && options.submitDto?.answers) {
          const byEq = new Map(answers.map((a) => [a.exam_question_id, a]));
          const now = new Date();
          for (const item of options.submitDto.answers) {
            const row = byEq.get(item.exam_question_id);
            if (!row) continue;
            this.assertValidResponse(eqById.get(row.exam_question_id), item.response);
            row.response = item.response ?? null;
            row.answered_at = item.response != null ? now : row.answered_at;
          }
          await manager.save(ExamAttemptAnswer, answers);
        }

        await this.gradingOrchestrator.applyObjectiveGrades(
          manager,
          answers,
          eqById,
          exam.config.negative_marking,
        );

        attempt.submitted_at = new Date();
        if (options.submitDto?.idempotency_key !== undefined) {
          attempt.idempotency_key = options.submitDto.idempotency_key;
        }
        const graded = await this.gradingOrchestrator.recomputeAndPersist(
          manager,
          attempt,
          answers,
          exam.passing_marks,
          { autoSubmitted: options.auto },
        );

        return {
          summary: this.toSummary(graded, answers),
          examId: attempt.exam_id,
          manualAnswerIds: answers.filter((a) => a.manual_required).map((a) => a.id),
          owners: { studentId: attempt.student_id, teacherId: exam.teacher_id },
        };
      },
    );

    // The finalisation is durable: invalidate the student's and the exam owner's
    // cached slices first, so a queue failure below cannot leave them stale. This
    // funnel also serves auto-submit and the expiry sweep, which have no request.
    if (owners !== null) {
      await this.invalidateAttemptCaches(owners.studentId, owners.teacherId, true);
    }

    // Post-commit side effects (queues): cancel the pending auto-submit, refresh
    // analytics, and request AI suggestions for any pending manual answers.
    await this.jobs.cancelAutoSubmit(attemptId);
    await this.jobs.enqueueAnalytics(examId);
    for (const answerId of manualAnswerIds) await this.jobs.enqueueAiGrade(answerId);

    // The grade is now durable. Publishing here (rather than inside the
    // transaction) means a guardian is never told about a score a rollback
    // erased. No-ops unless the attempt actually reached GRADED — one still
    // awaiting manual marking sits in GRADING and notifies nobody yet.
    await this.examGradedPublisher.publishIfGraded(attemptId);

    this.logger.log(
      `Attempt ${attemptId} finalised (${options.auto ? 'auto' : 'manual'}) → ${summary.state}`,
    );
    return summary;
  }

  /**
   * Invalidates only the two owners an attempt write affects (the student and the
   * exam's teacher) instead of every owner's entries. Best-effort: a cache failure
   * must never fail an already-committed attempt.
   */
  private async invalidateAttemptCaches(
    studentId: string,
    teacherId: string,
    reachedSubmission: boolean,
  ): Promise<void> {
    try {
      await this.applicationCache.invalidateScopes([
        ...studentExamCacheScopes(studentId),
        ...teacherExamCacheScopes(teacherId),
        ...(reachedSubmission ? teacherQuizCacheScopes(teacherId) : []),
        ...(reachedSubmission ? studentQuizCacheScopes(studentId) : []),
      ]);
    } catch (error) {
      this.logger.error(
        `Failed to invalidate exam caches after an attempt write: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ==================== RESULT ====================

  public async getResult(studentId: string, examId: string): Promise<unknown> {
    await this.access.assertCanAccessExam(studentId, examId);
    const attempt = await this.attempts.findOne({
      where: { exam_id: examId, student_id: studentId },
      order: { attempt_number: 'DESC' },
    });
    if (!attempt)
      throw new NotFoundException(
        biBody('You have not attempted this exam', 'لم تقم بأداء هذا الاختبار'),
      );

    const exam = await this.exams.findOneOrFail({ where: { id: examId } });
    const visible = this.resultVisible(attempt, exam.config);
    if (!visible) {
      return {
        exam_id: examId,
        attempt_id: attempt.id,
        state: attempt.state,
        available: false,
        message: 'Results are not available yet.',
      };
    }

    const answers = await this.answers.find({
      where: { attempt_id: attempt.id },
      order: { order_index: 'ASC' },
    });
    const eqById = new Map(
      (await this.examQuestions.find({ where: { exam_id: examId } })).map((eq) => [eq.id, eq]),
    );
    const revealAnswers = attempt.state === AttemptState.GRADED;

    return {
      exam_id: examId,
      attempt_id: attempt.id,
      state: attempt.state,
      available: true,
      score_auto: attempt.score_auto,
      score_manual: attempt.score_manual,
      score_total: attempt.score_total,
      max_score: attempt.max_score,
      passed: attempt.passed,
      submitted_at: attempt.submitted_at,
      graded_at: attempt.graded_at,
      answers: answers.map((a) => {
        const eq = eqById.get(a.exam_question_id);
        return {
          exam_question_id: a.exam_question_id,
          order: a.order_index,
          type: eq?.type_snapshot,
          content: eq?.content_snapshot,
          your_response: a.response,
          score: a.score,
          max_score: a.max_score,
          is_correct: a.is_correct,
          feedback: a.feedback,
          manual_required: a.manual_required,
          answer_key: revealAnswers ? eq?.answer_key_snapshot : undefined,
        };
      }),
    };
  }

  // ==================== HELPERS ====================

  private assertOpen(exam: Exam): void {
    if (exam.status !== ExamStatus.PUBLISHED && exam.status !== ExamStatus.SCHEDULED) {
      throw new ForbiddenException(biBody('This exam is not available', 'هذا الاختبار غير متاح'));
    }
    const now = Date.now();
    const { start_window_at: start, end_window_at: end } = exam.config;
    if (start != null && now < new Date(start).getTime()) {
      throw new ForbiddenException(
        biBody('This exam has not opened yet', 'لم يفتح هذا الاختبار بعد'),
      );
    }
    if (end != null && now > new Date(end).getTime()) {
      throw new ForbiddenException(biBody('This exam has closed', 'تم إغلاق هذا الاختبار'));
    }
  }

  private async loadOwnedAttempt(studentId: string, attemptId: string): Promise<ExamAttempt> {
    const attempt = await this.attempts.findOne({
      where: { id: attemptId, student_id: studentId },
    });
    if (!attempt) throw new NotFoundException(biBody('Attempt not found', 'المحاولة غير موجودة'));
    return attempt;
  }

  private isExpired(attempt: ExamAttempt, config: ExamConfig): boolean {
    return Date.now() > attempt.deadline_at.getTime() + config.grace_seconds * 1000;
  }

  private resultVisible(attempt: ExamAttempt, config: ExamConfig): boolean {
    switch (config.review_policy) {
      case ReviewPolicy.NEVER:
        return false;
      case ReviewPolicy.AFTER_SUBMIT:
        return attempt.state !== AttemptState.IN_PROGRESS;
      case ReviewPolicy.AFTER_CLOSE:
        return (
          config.end_window_at != null && Date.now() > new Date(config.end_window_at).getTime()
        );
      case ReviewPolicy.AFTER_GRADED:
      default:
        return attempt.state === AttemptState.GRADED;
    }
  }

  /** Deterministic per-attempt question order (optionally shuffled). */
  private orderQuestions(
    examQuestions: ExamQuestion[],
    config: ExamConfig,
    seed: number,
  ): ExamQuestion[] {
    const base = [...examQuestions].sort((a, b) => a.order_index - b.order_index);
    return config.shuffle_questions ? seededShuffle(base, seed) : base;
  }

  private async renderAttempt(attempt: ExamAttempt): Promise<RenderedAttempt> {
    const exam = await this.exams.findOneOrFail({ where: { id: attempt.exam_id } });
    const examQuestions = await this.examQuestions.find({ where: { exam_id: attempt.exam_id } });
    const sections = await this.dataSource.getRepository(ExamSection).find({
      where: { exam_id: attempt.exam_id },
      order: { order_index: 'ASC' },
    });
    const eqById = new Map(examQuestions.map((eq) => [eq.id, eq]));
    const answers = await this.answers.find({
      where: { attempt_id: attempt.id },
      order: { order_index: 'ASC' },
    });

    const now = new Date();
    const remainingMs = attempt.deadline_at.getTime() - now.getTime();

    const questions: RenderedQuestion[] = answers.map((a) => {
      const eq = eqById.get(a.exam_question_id);
      const content = this.renderContent(eq, attempt.shuffle_seed, exam.config);
      return {
        exam_question_id: a.exam_question_id,
        section_id: eq?.section_id ?? '',
        order: a.order_index,
        type: eq?.type_snapshot ?? '',
        marks: eq?.marks ?? 0,
        is_bonus: eq?.is_bonus ?? false,
        content,
        saved_response: a.response,
      };
    });

    return {
      attempt_id: attempt.id,
      exam_id: attempt.exam_id,
      state: attempt.state,
      session_token: attempt.session_token,
      started_at: attempt.started_at,
      deadline_at: attempt.deadline_at,
      server_time: now,
      remaining_seconds: Math.max(0, Math.floor(remainingMs / 1000)),
      total_marks: exam.total_marks,
      sections: sections.map((section) => ({
        id: section.id,
        order: section.order_index,
        title: section.title,
        title_ar: section.title_ar,
        description: section.description,
      })),
      questions,
    };
  }

  /** Student-safe content (answer key excluded); shuffles choices if configured. */
  private renderContent(
    eq: ExamQuestion | undefined,
    seed: number,
    config: ExamConfig,
  ): Record<string, unknown> {
    if (!eq) return {};
    const content = { ...eq.content_snapshot };
    if (config.shuffle_choices && Array.isArray(content['options'])) {
      content['options'] = seededShuffle(content['options'] as unknown[], deriveSeed(seed, eq.id));
    }
    return content;
  }

  private assertValidResponse(
    question: ExamQuestion | undefined,
    response: QuestionResponsePayload | null | undefined,
  ): void {
    if (response === null || response === undefined) return;
    if (!question) return;
    const errors = this.questionTypes.require(question.type_snapshot).validateResponse(response);
    if (errors.length > 0) {
      throw new BadRequestException({
        message: 'Invalid answer payload',
        exam_question_id: question.id,
        errors,
      });
    }
  }

  private toSummary(attempt: ExamAttempt, answers: ExamAttemptAnswer[]): SubmissionSummary {
    return {
      attempt_id: attempt.id,
      state: attempt.state,
      auto_submitted: attempt.auto_submitted,
      score_auto: attempt.score_auto,
      score_total: attempt.score_total,
      max_score: attempt.max_score,
      passed: attempt.passed,
      pending_manual: answers.filter((a) => a.manual_required).length,
      submitted_at: attempt.submitted_at,
    };
  }

  private isOpenAttemptConflict(err: unknown): boolean {
    const e = err as {
      code?: string;
      constraint?: string;
      driverError?: { code?: string; constraint?: string };
    };
    const code = e.code ?? e.driverError?.code;
    const constraint = e.constraint ?? e.driverError?.constraint;
    return (
      code === '23505' && constraint !== undefined && ATTEMPT_CONFLICT_CONSTRAINTS.has(constraint)
    );
  }
}
