import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { Difficulty } from '../../exams/entities/difficulty.enum';
import { Question } from '../../exams/entities';
import { Lesson } from '../../lessons/entities/lesson.entity';
import { QuestionTypeRegistry } from '../../exams/question-types/question-type-registry';
import { seededShuffle } from '../../exams/services/shuffle.util';
import { DEFAULT_DIFFICULTY } from '../gamification.constants';
import { PracticeSession } from '../entities';
import { GameNotificationsService } from './game-notifications.service';
import { GamificationService, SolveResult } from './gamification.service';
import { RankService } from './rank.service';
import { biBody } from '../../i18n/error-translator.util';

/** A question rendered for practice — never carries the answer key. */
export interface RenderedQuestion {
  id: string;
  type: string;
  difficulty: Difficulty;
  subject_id: string;
  lesson_id: string | null;
  content: Record<string, unknown>;
  already_solved: boolean;
}

export interface SubmitResult extends SolveResult {
  /** The correct-answer payload, revealed only in the post-answer response. */
  solution: Record<string, unknown>;
  explanation: string | null;
  reference_lesson: { id: string; title: string } | null;
}

/**
 * The practice loop: pick a question (unsolved-first, choices shuffled), grade a
 * submission via the shared question-type registry, and delegate all economy
 * side-effects to `GamificationService`. Zero exam scaffolding — a question is
 * graded directly against its answer key.
 */
@Injectable()
export class PracticeService {
  constructor(
    @InjectRepository(Question)
    private readonly questions: Repository<Question>,
    @InjectRepository(Lesson)
    private readonly lessons: Repository<Lesson>,
    @InjectRepository(PracticeSession)
    private readonly sessions: Repository<PracticeSession>,
    private readonly registry: QuestionTypeRegistry,
    private readonly gamification: GamificationService,
    private readonly rankService: RankService,
    private readonly gameNotifications: GameNotificationsService,
  ) {}

  /** Serve the next practice question, preferring ones the student hasn't solved. */
  public async getNext(
    userId: string,
    filters: { subjectId?: string | undefined; difficulty?: Difficulty | undefined },
  ): Promise<RenderedQuestion | null> {
    const unsolved = await this.pickQuestion(userId, filters, true);
    const question = unsolved ?? (await this.pickQuestion(userId, filters, false));
    if (!question) return null;
    return this.render(question, unsolved !== null ? false : true);
  }

  private async pickQuestion(
    userId: string,
    filters: { subjectId?: string | undefined; difficulty?: Difficulty | undefined },
    unsolvedOnly: boolean,
  ): Promise<Question | null> {
    const qb = this.questions
      .createQueryBuilder('q')
      .where('q.is_active = true')
      .andWhere('q.deleted_at IS NULL')
      // Practice is objective-only — exclude any type that needs manual grading
      // (e.g. essay), so a served question can always be graded instantly.
      .andWhere('q.type IN (:...types)', { types: this.objectiveTypes() });
    if (filters.subjectId) qb.andWhere('q.subject_id = :sid', { sid: filters.subjectId });
    if (filters.difficulty) qb.andWhere('q.difficulty = :dif', { dif: filters.difficulty });
    if (unsolvedOnly) {
      // Exclude questions this student has ever attempted (times_seen > 0), so
      // the "unsolved-first" pass never repeats a seen question.
      qb.andWhere(
        `NOT EXISTS (SELECT 1 FROM student_question_states s
                       WHERE s.user_id = :uid AND s.question_id = q.id)`,
        { uid: userId },
      );
    }
    // ORDER BY RANDOM() is fine at M1 scale; revisit with a keyset/sample
    // strategy if the bank grows very large (noted as tech debt).
    return qb.orderBy('RANDOM()').limit(1).getOne();
  }

  /** Question types that can be graded instantly (everything except manual). */
  private objectiveTypes(): string[] {
    return this.registry
      .list()
      .filter((def) => !def.requiresManualGrading)
      .map((def) => def.type);
  }

  private render(question: Question, alreadySolved: boolean): RenderedQuestion {
    const content: Record<string, unknown> = { ...question.content };
    // Shuffle choice order for choice-type questions (anti-cheat). Answer keys
    // reference option ids, so display order carries no information.
    if (Array.isArray(content['options'])) {
      content['options'] = seededShuffle(
        content['options'] as unknown[],
        Math.floor(Math.random() * 0x7fffffff),
      );
    }
    return {
      id: question.id,
      type: question.type,
      difficulty: question.difficulty ?? DEFAULT_DIFFICULTY,
      subject_id: question.subject_id,
      lesson_id: question.lesson_id,
      content,
      already_solved: alreadySolved,
    };
  }

  /** Grade a submission, apply the economy, and build the post-answer payload. */
  public async submitAnswer(
    userId: string,
    dto: {
      questionId: string;
      response: Record<string, unknown> | null;
      timeMs: number;
      sessionId?: string | null;
    },
  ): Promise<SubmitResult> {
    const question = await this.questions.findOne({
      where: { id: dto.questionId, is_active: true },
    });
    if (!question) throw new NotFoundException(biBody('Question not found', 'السؤال غير موجود'));

    const definition = this.registry.require(question.type);
    const response = dto.response ?? null;
    if (response !== null) {
      const errors = definition.validateResponse(response);
      if (errors.length > 0) {
        throw new BadRequestException({ message: 'Invalid response payload', errors });
      }
    }

    const grade = definition.grade(response, question.answer_key);
    // Practice is objective-only: a manual-grading type has no instant verdict.
    if (grade.manualRequired || grade.isCorrect === null) {
      throw new BadRequestException(
        biBody(
          'This question type cannot be practiced (requires manual grading)',
          'لا يمكن التدرب على هذا النوع من الأسئلة (يتطلب تصحيحًا يدويًا)',
        ),
      );
    }

    const result = await this.gamification.recordSolve({
      userId,
      questionId: question.id,
      questionVersion: question.current_version,
      subjectId: question.subject_id,
      lessonId: question.lesson_id,
      difficulty: question.difficulty ?? DEFAULT_DIFFICULTY,
      isCorrect: grade.isCorrect,
      response,
      timeMs: dto.timeMs,
      sessionId: dto.sessionId ?? null,
    });

    const referenceLesson = question.lesson_id
      ? await this.lessons.findOne({
          where: { id: question.lesson_id },
          select: { id: true, title: true },
        })
      : null;

    const explanationRaw = (question.content as Record<string, unknown>)['explanation'];
    const explanation = this.extractText(explanationRaw);

    // Fire-and-forget engagement notifications (post-commit; never blocks/fails
    // the response). Resolve the tier once for the rank-up message.
    if (result.rankUp || result.streakExtendedToday) {
      const tier = await this.rankService.resolveTier(result.globalRating, result.xp);
      void this.gameNotifications.notifyForSolve(userId, result, tier);
    }

    return {
      ...result,
      solution: question.answer_key,
      explanation,
      reference_lesson: referenceLesson
        ? { id: referenceLesson.id, title: referenceLesson.title }
        : null,
    };
  }

  /** Open a practice session. */
  public async startSession(
    userId: string,
    filters: { subjectId?: string | undefined; difficulty?: Difficulty | undefined },
  ): Promise<PracticeSession> {
    await this.gamification.ensureProfile(userId);
    const session = this.sessions.create({
      user_id: userId,
      subject_id: filters.subjectId ?? null,
      difficulty: filters.difficulty ?? null,
    });
    return this.sessions.save(session);
  }

  /** Close a practice session (best-effort; ownership-checked). */
  public async endSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.sessions.findOne({ where: { id: sessionId, user_id: userId } });
    if (!session || session.ended_at !== null) return;
    session.ended_at = new Date();
    await this.sessions.save(session);
  }

  /** Best-effort extraction of a display string from a LocalizedText or string. */
  private extractText(value: unknown): string | null {
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (value && typeof value === 'object') {
      const en = (value as Record<string, unknown>)['en'];
      const ar = (value as Record<string, unknown>)['ar'];
      if (typeof en === 'string' && en.trim() !== '') return en;
      if (typeof ar === 'string' && ar.trim() !== '') return ar;
    }
    return null;
  }
}
