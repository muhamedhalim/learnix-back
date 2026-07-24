import type { QueryRunner } from 'typeorm';

import { EnforceSinglePublicPracticeAttempt1960000000000 } from '../../migrations/1960000000000-EnforceSinglePublicPracticeAttempt';

describe('single public-practice attempt migration', () => {
  it('deduplicates historical solves, repairs profile totals, and adds the database uniqueness guard', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new EnforceSinglePublicPracticeAttempt1960000000000().up({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM "question_solves" duplicate'));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE "student_game_profiles" gp'));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UQ_question_solves_user_question'));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('IDX_question_solves_subject_created'));
  });
});
