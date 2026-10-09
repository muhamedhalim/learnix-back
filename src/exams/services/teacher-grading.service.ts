import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, Repository } from 'typeorm';

import { ApplicationCacheService } from '../../common/cache/application-cache.service';
import { PaginatedResponse, PaginationMeta } from '../../common/interfaces/pagination.interface';
import { biBody } from '../../i18n/error-translator.util';
import { GradeAnswerDto } from '../dto';
import { Exam, ExamAttempt, ExamAttemptAnswer, ExamQuestion, QuestionType } from '../entities';
import { AttemptGradingService } from './attempt-grading.service';
import { studentExamCacheScopes, studentQuizCacheScopes } from './exam-cache-scopes';
import { ExamGradedPublisher } from './exam-graded-publisher.service';
import { ExamJobsService } from './exam-jobs.service';

const AUTO_GRADED_TYPES = new Set<QuestionType>([
  QuestionType.SINGLE_CHOICE,
  QuestionType.MULTIPLE_SELECT,
  QuestionType.TRUE_FALSE,
  QuestionType.FILL_BLANK,
  QuestionType.NUMERIC,
]);

/** Teacher-facing grading: view submissions, inspect an attempt, grade essays. */
@Injectable()
export class TeacherGradingService {
  private readonly logger = new Logger(TeacherGradingService.name);

  constructor(
    @InjectRepository(Exam) private readonly exams: Repository<Exam>,
    @InjectRepository(ExamAttempt) private readonly attempts: Repository<ExamAttempt>,
    @InjectRepository(ExamAttemptAnswer) private readonly answers: Repository<ExamAttemptAnswer>,
    @InjectRepository(ExamQuestion) private readonly examQuestions: Repository<ExamQuestion>,
    private readonly dataSource: DataSource,
    private readonly gradingOrchestrator: AttemptGradingService,
    private readonly jobs: ExamJobsService,
    private readonly examGradedPublisher: ExamGradedPublisher,
    private readonly applicationCache: ApplicationCacheService,
  ) {}

  public async getSubmissions(
    examId: string,
    teacherId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<unknown>> {
    await this.assertExamOwner(examId, teacherId);
    const [rows, total] = await this.attempts.findAndCount({
      where: { exam_id: examId },
      relations: ['student'],
      // Only what the response maps, plus the order/where/join columns the paged-ids path needs.
      select: {
        id: true,
        exam_id: true,
        student_id: true,
        attempt_number: true,
        state: true,
        score_auto: true,
        score_manual: true,
        score_total: true,
        max_score: true,
        passed: true,
        submitted_at: true,
        created_at: true,
        student: { id: true, name: true, email: true },
      },
      order: { submitted_at: 'DESC', created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const data = rows.map((a) => ({
      attempt_id: a.id,
      student: { id: a.student.id, name: a.student.name, email: a.student.email },
      attempt_number: a.attempt_number,
      state: a.state,
      score_auto: a.score_auto,
      score_manual: a.score_manual,
      score_total: a.score_total,
      max_score: a.max_score,
      passed: a.passed,
      submitted_at: a.submitted_at,
    }));
    return { data, meta: this.meta(total, page, limit) };
  }

  public async getAttemptDetail(
    examId: string,
    attemptId: string,
    teacherId: string,
  ): Promise<unknown> {
    await this.assertExamOwner(examId, teacherId);
    const attempt = await this.attempts.findOne({
      where: { id: attemptId, exam_id: examId },
      relations: ['student'],
    });
    if (!attempt) throw new NotFoundException(biBody('Attempt not found', 'المحاولة غير موجودة'));

    const answers = await this.answers.find({
      where: { attempt_id: attemptId },
      order: { order_index: 'ASC' },
    });
    const eqById = new Map(
      (await this.examQuestions.find({ where: { exam_id: examId } })).map((eq) => [eq.id, eq]),
    );

    return {
      attempt_id: attempt.id,
      student: { id: attempt.student.id, name: attempt.student.name, email: attempt.student.email },
      state: attempt.state,
      score_auto: attempt.score_auto,
      score_manual: attempt.score_manual,
      score_total: attempt.score_total,
      max_score: attempt.max_score,
      answers: answers.map((a) => {
        const eq = eqById.get(a.exam_question_id);
        return {
          answer_id: a.id,
          exam_question_id: a.exam_question_id,
          order: a.order_index,
          type: eq?.type_snapshot,
          content: eq?.content_snapshot,
          answer_key: eq?.answer_key_snapshot,
          response: a.response,
          score: a.score,
          max_score: a.max_score,
          is_correct: a.is_correct,
          feedback: a.feedback,
          manual_required: a.manual_required,
          ai_suggested_score: a.ai_suggested_score,
          ai_confidence: a.ai_confidence,
        };
      }),
    };
  }

  /** Grade one manual answer; recomputes attempt totals and refreshes analytics. */
  public async gradeAnswer(
    examId: string,
    answerId: string,
    teacherId: string,
    dto: GradeAnswerDto,
  ): Promise<{ attempt_id: string; state: string; score_total: number | null }> {
    const exam = await this.assertExamOwner(examId, teacherId);

    // One read for the answer, its attempt (constrained to THIS exam, so another exam's answer
    // never matches) and its question, instead of three.
    const found = (await this.answers
      .createQueryBuilder('answer')
      .innerJoinAndMapOne(
        'answer.joinedAttempt',
        ExamAttempt,
        'attempt',
        'attempt.id = answer.attempt_id AND attempt.exam_id = :examId',
        { examId },
      )
      .leftJoinAndMapOne(
        'answer.joinedQuestion',
        ExamQuestion,
        'eq',
        'eq.id = answer.exam_question_id',
      )
      .where('answer.id = :answerId', { answerId })
      .getOne()) as
      | (ExamAttemptAnswer & { joinedAttempt: ExamAttempt; joinedQuestion: ExamQuestion | null })
      | null;
    if (!found) {
      // Only now, to choose between the two distinct 404 bodies, look the answer up on its own.
      const exists = await this.answers.findOne({ where: { id: answerId } });
      if (!exists) throw new NotFoundException(biBody('Answer not found', 'الإجابة غير موجودة'));
      throw new NotFoundException(
        biBody('Answer does not belong to this exam', 'هذه الإجابة لا تنتمي إلى هذا الاختبار'),
      );
    }
    const answer = found;
    const attempt = found.joinedAttempt;
    const examQuestion = found.joinedQuestion;
    if (examQuestion && AUTO_GRADED_TYPES.has(examQuestion.type_snapshot)) {
      throw new BadRequestException(
        biBody(
          'This question is auto-graded and cannot be graded manually',
          'يتم تصحيح هذا السؤال تلقائيًا ولا يمكن تصحيحه يدويًا',
        ),
      );
    }
    if (dto.score > answer.max_score) {
      throw new BadRequestException(
        biBody(
          `Score (${String(dto.score)}) exceeds the maximum marks (${String(answer.max_score)})`,
          `الدرجة (${String(dto.score)}) تتجاوز الحد الأقصى للدرجات (${String(answer.max_score)})`,
        ),
      );
    }

    const state = await this.dataSource.transaction(async (manager) => {
      const locked = await manager.findOneOrFail(ExamAttempt, {
        where: { id: attempt.id },
        lock: { mode: 'pessimistic_write' },
      });
      const target = await manager.findOneOrFail(ExamAttemptAnswer, { where: { id: answerId } });
      target.score = dto.score;
      target.feedback = dto.feedback ?? null;
      target.graded_by = teacherId;
      target.manual_required = false;
      target.auto_graded = false;
      await manager.save(ExamAttemptAnswer, target);

      const allAnswers = await manager.find(ExamAttemptAnswer, {
        where: { attempt_id: attempt.id },
      });
      return this.gradingOrchestrator.recomputeAndPersist(
        manager,
        locked,
        allAnswers,
        exam.passing_marks,
      );
    });

    // The committed grade changes this student's dashboard, profile and report. The
    // route declares the teacher's own slice (`self`, the exam owner); the student
    // is a different owner, so that slice is invalidated here, after the commit.
    await this.invalidateStudentCaches(attempt.student_id);

    await this.jobs.enqueueAnalytics(examId);

    // Manually grading the last outstanding answer is what flips an attempt from
    // GRADING to GRADED — the other place a parent-visible result is born.
    // Post-commit, same as the student submit path.
    await this.examGradedPublisher.publishIfGraded(attempt.id);

    return { attempt_id: attempt.id, state: state.state, score_total: state.score_total };
  }

  /** Best-effort: a cache failure must never fail an already-committed grade. */
  private async invalidateStudentCaches(studentId: string): Promise<void> {
    try {
      await this.applicationCache.invalidateScopes([
        ...studentExamCacheScopes(studentId),
        ...studentQuizCacheScopes(studentId),
      ]);
    } catch (error) {
      this.logger.error(
        `Failed to invalidate student caches after grading: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async assertExamOwner(examId: string, teacherId: string): Promise<Exam> {
    const exam = await this.exams.findOne({ where: { id: examId, teacher_id: teacherId } });
    if (!exam) throw new NotFoundException(biBody('Exam not found', 'الاختبار غير موجود'));
    return exam;
  }

  private meta(total: number, page: number, limit: number): PaginationMeta {
    const totalPages = Math.ceil(total / limit);
    return {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
  }
}
