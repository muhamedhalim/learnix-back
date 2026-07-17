import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Repository } from 'typeorm';

import { PARENT_EVENT_CHANNEL } from '../../notifications/events/parent-events';
import { User } from '../../users/entities/user.entity';
import { AttemptState, Exam, ExamAttempt, ExamAttemptAnswer } from '../entities';
import { ExamGradedPublisher } from './exam-graded-publisher.service';

describe('ExamGradedPublisher', () => {
  it('emits a complete result only after grading', async () => {
    const gradedAt = new Date('2026-07-17T12:00:00.000Z');
    const attempts = {
      findOne: jest.fn().mockResolvedValue({
        id: 'attempt-1',
        exam_id: 'exam-1',
        student_id: 'student-1',
        state: AttemptState.GRADED,
        score_total: 8,
        passed: true,
        graded_at: gradedAt,
      }),
      count: jest.fn().mockResolvedValue(1),
    } as unknown as Repository<ExamAttempt>;
    const answers = {
      find: jest.fn().mockResolvedValue([
        { score: 5, max_score: 5, feedback: 'Excellent.' },
        { score: 0, max_score: 5, feedback: null },
      ]),
    } as unknown as Repository<ExamAttemptAnswer>;
    const exams = {
      findOne: jest.fn().mockResolvedValue({ id: 'exam-1', title: 'Physics', total_marks: 10 }),
    } as unknown as Repository<Exam>;
    const users = {
      findOne: jest.fn().mockResolvedValue({ id: 'student-1', name: 'Mona' }),
    } as unknown as Repository<User>;
    const events = { emit: jest.fn() } as unknown as EventEmitter2;
    const publisher = new ExamGradedPublisher(attempts, answers, exams, users, events);

    await publisher.publishIfGraded('attempt-1');

    expect(events.emit).toHaveBeenCalledWith(
      PARENT_EVENT_CHANNEL,
      expect.objectContaining({
        studentId: 'student-1',
        subjectId: 'attempt-1',
        variables: expect.objectContaining({
          examName: 'Physics',
          score: 8,
          totalMarks: 10,
          percentage: 80,
          status: 'passed',
          gradedAt: gradedAt.toISOString(),
        }),
      }),
    );
  });

  it('does not notify parents about an incomplete grade', async () => {
    const attempts = {
      findOne: jest.fn().mockResolvedValue({ state: AttemptState.GRADING }),
    } as unknown as Repository<ExamAttempt>;
    const events = { emit: jest.fn() } as unknown as EventEmitter2;
    const publisher = new ExamGradedPublisher(
      attempts,
      {} as Repository<ExamAttemptAnswer>,
      {} as Repository<Exam>,
      {} as Repository<User>,
      events,
    );

    await publisher.publishIfGraded('attempt-1');

    expect(events.emit).not.toHaveBeenCalled();
  });
});
