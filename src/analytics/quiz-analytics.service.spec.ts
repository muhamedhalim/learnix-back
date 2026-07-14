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

  it('bounds student progress and returns database-ranked attempt/topic highlights', async () => {
    const summaryBuilder: Record<string, jest.Mock> = {};
    for (const method of ['select', 'addSelect', 'where', 'andWhere']) {
      summaryBuilder[method] = jest.fn(() => summaryBuilder);
    }
    summaryBuilder.getRawOne = jest.fn().mockResolvedValue({
      attempts: '10000',
      avgPercent: '75',
      passRate: '80',
      timeSeconds: '3600',
    });
    attempts.createQueryBuilder.mockReturnValue(summaryBuilder);
    attempts.query.mockResolvedValue([
      {
        bestQuiz: { title: 'Best', percent: 100 },
        worstQuiz: { title: 'Worst', percent: 20 },
        progress: [{ date: '2026-07-14', percent: 90 }],
      },
    ]);
    answers.query.mockResolvedValue([
      {
        strongTopics: [{ topic: 'Algebra', answers: 50, percent: 90 }],
        weakTopics: [{ topic: 'Geometry', answers: 20, percent: 40 }],
      },
    ]);

    const result = await service.getStudentAnalytics('student-1');

    expect(result).toMatchObject({
      totalAttempts: 10000,
      bestQuiz: { title: 'Best', percent: 100 },
      worstQuiz: { title: 'Worst', percent: 20 },
      strongTopics: [{ topic: 'Algebra', answers: 50, percent: 90 }],
      weakTopics: [{ topic: 'Geometry', answers: 20, percent: 40 }],
    });
    const attemptSql = attempts.query.mock.calls[0]?.[0] as string;
    const topicSql = answers.query.mock.calls[0]?.[0] as string;
    expect(attemptSql).toContain('LIMIT 100');
    expect(topicSql).toContain('WITH topic_stats AS');
    expect(topicSql).toContain('LIMIT 5');
  });
});
