import { ConflictException } from '@nestjs/common';

import { AttemptState, ExamAttempt } from '../entities';
import { AttemptService } from './attempt.service';

function buildService(existingAttempt: ExamAttempt | null): {
  service: AttemptService;
  attempts: { findOne: jest.Mock };
  dataSource: { transaction: jest.Mock };
} {
  const access = {
    assertCanAccessPrivateExam: jest.fn().mockResolvedValue(undefined),
  };
  const attempts = { findOne: jest.fn().mockResolvedValue(existingAttempt) };
  const dataSource = { transaction: jest.fn() };
  const service = new AttemptService(
    {} as never, // exams
    {} as never, // examQuestions
    attempts as never,
    {} as never, // answers
    dataSource as never,
    {} as never, // gradingOrchestrator
    {} as never, // jobs
    access as never,
    {} as never, // examGradedPublisher
    {} as never, // questionTypes
  );
  return { service, attempts, dataSource };
}

describe('AttemptService.createOmrAttempt — origin guard', () => {
  it('reuses its own prior OMR attempt idempotently', async () => {
    const existing = { id: 'attempt-1', origin: 'omr', state: AttemptState.GRADED } as ExamAttempt;
    const { service, dataSource } = buildService(existing);

    const result = await service.createOmrAttempt('exam-1', 'student-1');

    expect(result).toBe(existing);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects when the student has a live IN_PROGRESS online attempt, rather than hijacking it', async () => {
    const liveOnline = {
      id: 'attempt-1',
      origin: 'online',
      state: AttemptState.IN_PROGRESS,
    } as ExamAttempt;
    const { service } = buildService(liveOnline);

    await expect(service.createOmrAttempt('exam-1', 'student-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects when the student has a prior GRADED online attempt, rather than silently discarding OMR answers', async () => {
    const gradedOnline = {
      id: 'attempt-1',
      origin: 'online',
      state: AttemptState.GRADED,
    } as ExamAttempt;
    const { service } = buildService(gradedOnline);

    await expect(service.createOmrAttempt('exam-1', 'student-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects for an EXPIRED online attempt too — origin, not state, is what gates OMR reuse', async () => {
    const expiredOnline = {
      id: 'attempt-1',
      origin: 'online',
      state: AttemptState.EXPIRED,
    } as ExamAttempt;
    const { service } = buildService(expiredOnline);

    await expect(service.createOmrAttempt('exam-1', 'student-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('treats a legacy attempt with no origin value as non-OMR (default column value is "online")', async () => {
    const legacy = { id: 'attempt-1', state: AttemptState.GRADED } as ExamAttempt; // origin undefined
    const { service } = buildService(legacy);

    await expect(service.createOmrAttempt('exam-1', 'student-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
