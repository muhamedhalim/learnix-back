import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { ExamGradedEvent, PARENT_EVENT_CHANNEL } from '../../notifications/events/parent-events';
import { User } from '../../users/entities/user.entity';
import { AttemptState } from '../entities/attempt-state.enum';
import { Exam } from '../entities/exam.entity';
import { ExamAttempt } from '../entities/exam-attempt.entity';
import { ExamAttemptAnswer } from '../entities/exam-attempt-answer.entity';

/**
 * Publishes `ExamGradedEvent` once an attempt reaches a terminal GRADED state.
 *
 * Called from *after* the grading transaction commits, never inside it. Emitting
 * inside would let a listener observe (and message a parent about) a grade that
 * a later statement rolls back — the classic dual-write hazard. Both grading
 * entry points (student submit, teacher manual grade) funnel through here so
 * the payload is computed identically.
 *
 * Every failure is swallowed: a parent notification must never be able to fail
 * a student's committed exam submission.
 */
@Injectable()
export class ExamGradedPublisher {
  private readonly logger = new Logger(ExamGradedPublisher.name);

  constructor(
    @InjectRepository(ExamAttempt) private readonly attempts: Repository<ExamAttempt>,
    @InjectRepository(ExamAttemptAnswer) private readonly answers: Repository<ExamAttemptAnswer>,
    @InjectRepository(Exam) private readonly exams: Repository<Exam>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * No-op unless the attempt is GRADED — a submission awaiting manual marking
   * sits in GRADING, and telling a parent about a partial score would be wrong.
   */
  public async publishIfGraded(attemptId: string): Promise<void> {
    try {
      const attempt = await this.attempts.findOne({ where: { id: attemptId } });
      if (!attempt || attempt.state !== AttemptState.GRADED) return;

      const [exam, student, answers] = await Promise.all([
        this.exams.findOne({ where: { id: attempt.exam_id } }),
        this.users.findOne({ where: { id: attempt.student_id } }),
        this.answers.find({ where: { attempt_id: attempt.id } }),
      ]);
      if (!exam || !student) return;

      const score = attempt.score_total ?? 0;
      const totalMarks = exam.total_marks;
      const percentage = totalMarks > 0 ? Math.round((score / totalMarks) * 100) : 0;

      // "Correct" means full marks on the question. Partially-credited answers
      // count as neither correct nor wrong, so the two never over-count.
      const correctAnswers = answers.filter(
        (answer) => answer.score !== null && answer.score >= answer.max_score,
      ).length;
      const wrongAnswers = answers.filter(
        (answer) => answer.score === null || answer.score <= 0,
      ).length;

      const { rank, cohortSize } = await this.computeRank(attempt.exam_id, score);

      const teacherNotes =
        answers
          .map((answer) => answer.feedback?.trim())
          .find((note) => note !== undefined && note !== '') ?? null;

      this.events.emit(
        PARENT_EVENT_CHANNEL,
        new ExamGradedEvent(attempt.student_id, attempt.id, {
          studentName: student.name,
          examName: exam.title,
          score,
          totalMarks,
          percentage,
          passed: attempt.passed ?? false,
          status: attempt.passed === true ? 'passed' : 'failed',
          gradedAt: (attempt.graded_at ?? new Date()).toISOString(),
          correctAnswers,
          wrongAnswers,
          rank,
          cohortSize,
          teacherNotes,
        }),
      );

      this.logger.log(`ExamGradedEvent emitted for attempt ${attempt.id}`);
    } catch (error) {
      this.logger.error(
        `Failed to publish ExamGradedEvent for attempt ${attemptId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Competition rank among graded attempts on the same exam (1 = best).
   * `null` when the student is the only graded attempt — "Rank: 1 / 1" is noise.
   */
  private async computeRank(
    examId: string,
    score: number,
  ): Promise<{ rank: number | null; cohortSize: number | null }> {
    const cohortSize = await this.attempts.count({
      where: { exam_id: examId, state: AttemptState.GRADED },
    });
    if (cohortSize < 2) return { rank: null, cohortSize: null };

    const better = await this.attempts
      .createQueryBuilder('a')
      .where('a.exam_id = :examId', { examId })
      .andWhere('a.state = :state', { state: AttemptState.GRADED })
      .andWhere('a.score_total > :score', { score })
      .getCount();

    return { rank: better + 1, cohortSize };
  }
}
