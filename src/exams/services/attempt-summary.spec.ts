import { AttemptState, ExamAttempt, ExamAttemptAnswer } from '../entities';
import { AttemptService } from './attempt.service';

function buildService(
  attempt: ExamAttempt | null,
  answers: Partial<ExamAttemptAnswer>[],
): { service: AttemptService; attempts: { findOne: jest.Mock }; answers: { find: jest.Mock } } {
  const attempts = { findOne: jest.fn().mockResolvedValue(attempt) };
  const answersRepo = { find: jest.fn().mockResolvedValue(answers) };
  const service = new AttemptService(
    {} as never, // exams
    {} as never, // examQuestions
    attempts as never,
    answersRepo as never,
    {} as never, // dataSource
    {} as never, // gradingOrchestrator
    {} as never, // jobs
    {} as never, // access
    {} as never, // examGradedPublisher
    {} as never, // questionTypes
  );
  return { service, attempts, answers: answersRepo };
}

describe('AttemptService.getSummary', () => {
  it('returns null for an attempt that does not exist', async () => {
    const { service } = buildService(null, []);

    await expect(service.getSummary('missing')).resolves.toBeNull();
  });

  it('derives pending_manual from the attempt’s own answers — never a hardcoded placeholder', async () => {
    const attempt = {
      id: 'attempt-1',
      state: AttemptState.GRADING,
      score_auto: 6,
      score_total: null,
      max_score: 10,
      passed: null,
      auto_submitted: false,
      submitted_at: new Date(),
    } as ExamAttempt;
    const { service, answers } = buildService(attempt, [
      { manual_required: true },
      { manual_required: true },
      { manual_required: false },
    ]);

    const summary = await service.getSummary('attempt-1');

    expect(answers.find).toHaveBeenCalledWith({ where: { attempt_id: 'attempt-1' } });
    expect(summary?.pending_manual).toBe(2);
    expect(summary?.state).toBe(AttemptState.GRADING);
  });

  it('reports zero pending_manual once every manual answer has been graded', async () => {
    const attempt = {
      id: 'attempt-2',
      state: AttemptState.GRADED,
      score_auto: 6,
      score_total: 9,
      max_score: 10,
      passed: true,
      auto_submitted: false,
      submitted_at: new Date(),
    } as ExamAttempt;
    const { service } = buildService(attempt, [
      { manual_required: false },
      { manual_required: false },
    ]);

    const summary = await service.getSummary('attempt-2');

    expect(summary?.pending_manual).toBe(0);
  });
});
