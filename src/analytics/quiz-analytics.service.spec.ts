import { ForbiddenException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Exam } from '../exams/entities/exam.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { ExamAttemptAnswer } from '../exams/entities/exam-attempt-answer.entity';
import { Question } from '../exams/entities/question.entity';
import { QuizAnalyticsService } from './quiz-analytics.service';

describe('QuizAnalyticsService.getExamQuestionAnalytics', () => {
  let service: QuizAnalyticsService;
  const attempts = { createQueryBuilder: jest.fn(), query: jest.fn() };
  const answers = { createQueryBuilder: jest.fn(), query: jest.fn() };
  const exams = { findOne: jest.fn() };
  const questions = { count: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuizAnalyticsService,
        { provide: getRepositoryToken(ExamAttempt), useValue: attempts },
        { provide: getRepositoryToken(ExamAttemptAnswer), useValue: answers },
        { provide: getRepositoryToken(Exam), useValue: exams },
        { provide: getRepositoryToken(Question), useValue: questions },
      ],
    }).compile();
    service = module.get(QuizAnalyticsService);
  });

  it('rejects analysing an exam owned by another teacher', async () => {
    exams.findOne.mockResolvedValue({ id: 'E1', teacher_id: 'other' });
    await expect(service.getExamQuestionAnalytics('E1', 'me')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns difficulty and discrimination aggregated by PostgreSQL', async () => {
    exams.findOne.mockResolvedValue({ id: 'E1', teacher_id: 'me' });
    answers.query.mockResolvedValue([
      {
        questionId: 'Q1',
        topic: 'Algebra',
        difficulty: 67,
        discrimination: 100,
        attempts: 3,
      },
    ]);

    const result = await service.getExamQuestionAnalytics('E1', 'me');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      questionId: 'Q1',
      topic: 'Algebra',
      attempts: 3,
      difficulty: 67,
      discrimination: 100,
    });
    expect(answers.query).toHaveBeenCalledTimes(1);
    const sql = answers.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('ROW_NUMBER() OVER');
    expect(sql).toContain('AVG(ranked.is_correct::int) FILTER');
    expect(answers.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns only finalized, student-visible attempts and includes manual marks and feedback', async () => {
    const summaryBuilder: Record<string, jest.Mock> = {};
    for (const method of ['innerJoinAndSelect', 'leftJoinAndSelect', 'where', 'andWhere', 'orderBy']) {
      summaryBuilder[method] = jest.fn(() => summaryBuilder);
    }
    summaryBuilder.getMany = jest.fn().mockResolvedValue([
      {
        id: 'attempt-1', state: 'graded', score_auto: 6, score_manual: 3, score_total: 9, max_score: 10,
        passed: true, started_at: new Date('2026-07-14T09:00:00Z'), submitted_at: new Date('2026-07-14T09:30:00Z'), graded_at: new Date('2026-07-14T10:00:00Z'), updated_at: new Date('2026-07-14T10:00:00Z'),
        exam: { title: 'Essay exam', config: { review_policy: 'after_graded' }, teacher: { name: 'Teacher' }, subject: { name: 'Math' }, package: null },
      },
      {
        id: 'attempt-2', state: 'graded', score_auto: 10, score_manual: 0, score_total: 10, max_score: 10,
        passed: true, started_at: new Date(), submitted_at: new Date(), graded_at: new Date(), updated_at: new Date(),
        exam: { title: 'Private result', config: { review_policy: 'never' }, teacher: { name: 'Teacher' }, subject: { name: 'Math' }, package: null },
      },
    ]);
    attempts.createQueryBuilder.mockReturnValue(summaryBuilder);
    answers.find = jest.fn().mockResolvedValue([{ attempt_id: 'attempt-1', score: 3, max_score: 4, feedback: 'Strong explanation', exam_question: { type_snapshot: 'essay', question: { topic: 'Algebra' } } }]);

    const result = await service.getStudentAnalytics('student-1');

    expect(result).toMatchObject({
      totalAttempts: 1,
      bestQuiz: { title: 'Essay exam', percent: 90 },
      attempts: [expect.objectContaining({ scoreManual: 3, scoreTotal: 9, feedback: ['Strong explanation'] })],
    });
    expect(result.attempts).not.toEqual(expect.arrayContaining([expect.objectContaining({ examName: 'Private result' })]));
  });

  it('computes teacher completion from eligible exam-student pairs, not attempts', async () => {
    attempts.query.mockResolvedValue([{ eligibleStudents: 25, completedStudents: 10 }]);

    const result = await (
      service as unknown as {
        getTeacherEligibilitySummary: (
          teacherId: string,
        ) => Promise<{ eligibleStudents: number; completedStudents: number }>;
      }
    ).getTeacherEligibilitySummary('teacher-1');

    expect(result).toEqual({ eligibleStudents: 25, completedStudents: 10 });
    const sql = attempts.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('exam.is_public = true');
    expect(sql).toContain('purchase.package_id = exam.package_id');
    expect(sql).toContain('purchase.lesson_id = exam.lesson_id');
    expect(sql).toContain('lesson_package_items');
    expect(sql).toContain('SELECT DISTINCT attempt.exam_id, attempt.student_id');
    expect(sql).toContain('COUNT(completed.student_id)');
  });
});
