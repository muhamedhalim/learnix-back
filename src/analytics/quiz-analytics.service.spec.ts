import { ForbiddenException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Exam } from '../exams/entities/exam.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { ExamAttemptAnswer } from '../exams/entities/exam-attempt-answer.entity';
import { Question } from '../exams/entities/question.entity';
import { QuizAnalyticsService } from './quiz-analytics.service';

function answersQb(rows: unknown[]) {
  const b: Record<string, jest.Mock> = {};
  for (const m of ['innerJoin', 'leftJoin', 'select', 'addSelect', 'where', 'andWhere', 'groupBy', 'addGroupBy', 'having', 'orderBy', 'limit']) {
    b[m] = jest.fn(() => b);
  }
  b.getRawMany = jest.fn().mockResolvedValue(rows);
  return b;
}

describe('QuizAnalyticsService.getExamQuestionAnalytics', () => {
  let service: QuizAnalyticsService;
  const attempts = { createQueryBuilder: jest.fn() };
  const answers = { createQueryBuilder: jest.fn() };
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
    await expect(
      service.getExamQuestionAnalytics('E1', 'me'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('computes difficulty (p-value) and top/bottom discrimination', async () => {
    exams.findOne.mockResolvedValue({ id: 'E1', teacher_id: 'me' });
    answers.createQueryBuilder.mockReturnValue(
      answersQb([
        { questionId: 'Q1', topic: 'Algebra', isCorrect: true, attemptPct: '0.9' },
        { questionId: 'Q1', topic: 'Algebra', isCorrect: true, attemptPct: '0.8' },
        { questionId: 'Q1', topic: 'Algebra', isCorrect: false, attemptPct: '0.2' },
      ]),
    );

    const result = await service.getExamQuestionAnalytics('E1', 'me');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      questionId: 'Q1',
      topic: 'Algebra',
      attempts: 3,
      difficulty: 67, // 2/3 correct
      discrimination: 100, // top third correct, bottom third wrong
    });
  });
});
