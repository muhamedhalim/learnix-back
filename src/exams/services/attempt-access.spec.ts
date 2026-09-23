import { NotFoundException } from '@nestjs/common';

import { AttemptState, ExamAttempt } from '../entities';
import { AttemptService } from './attempt.service';

function buildService(options?: { attempt?: ExamAttempt }): {
  service: AttemptService;
  access: {
    findAccessiblePrivateExam: jest.Mock;
    assertCanAccessPrivateExam: jest.Mock;
    findAccessibleExam: jest.Mock;
    assertCanAccessExam: jest.Mock;
  };
  attempts: { findOne: jest.Mock; count: jest.Mock };
  dataSource: { transaction: jest.Mock };
} {
  const denied = new NotFoundException('Exam not found');
  const access = {
    findAccessiblePrivateExam: jest.fn().mockRejectedValue(denied),
    assertCanAccessPrivateExam: jest.fn().mockRejectedValue(denied),
    findAccessibleExam: jest.fn().mockRejectedValue(denied),
    assertCanAccessExam: jest.fn().mockRejectedValue(denied),
  };
  const attempts = {
    findOne: jest.fn().mockResolvedValue(options?.attempt ?? null),
    count: jest.fn(),
  };
  const dataSource = { transaction: jest.fn() };
  const service = new AttemptService(
    {} as never,
    {} as never,
    attempts as never,
    {} as never,
    dataSource as never,
    {} as never,
    {} as never,
    access as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, access, attempts, dataSource };
}

describe('AttemptService audience enforcement', () => {
  it('prevents an unaffiliated student from initiating an attempt by exam id', async () => {
    const { service, access, attempts } = buildService();

    await expect(service.startAttempt('other-student', 'private-exam')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(access.findAccessibleExam).toHaveBeenCalledWith('other-student', 'private-exam');
    expect(attempts.findOne).not.toHaveBeenCalled();
  });

  it('prevents an out-of-scope student from saving or submitting an owned attempt', async () => {
    const attempt = {
      id: 'attempt-1',
      exam_id: 'private-exam',
      student_id: 'student-1',
      state: AttemptState.IN_PROGRESS,
    } as ExamAttempt;
    const { service, access, dataSource } = buildService({ attempt });

    await expect(
      service.saveAnswers('student-1', attempt.id, { answers: [] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.submit('student-1', attempt.id, { answers: [] })).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(access.assertCanAccessExam).toHaveBeenCalledTimes(2);
    expect(access.assertCanAccessExam).toHaveBeenCalledWith('student-1', 'private-exam');
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('does not distinguish a foreign attempt from an unknown attempt', async () => {
    const attempt = { id: 'attempt-1', student_id: 'student-2' } as ExamAttempt;
    const { service, attempts, access } = buildService();

    await expect(service.getAttempt('student-1', attempt.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(attempts.findOne).toHaveBeenCalledWith({
      where: { id: attempt.id, student_id: 'student-1' },
    });
    expect(access.assertCanAccessExam).not.toHaveBeenCalled();
  });
});
