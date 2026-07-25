import type { QueryRunner } from 'typeorm';

import { RemoveLegacyLessonDurationMinutes1970000000000 } from './1970000000000-RemoveLegacyLessonDurationMinutes';

function runner(hasLegacyColumn: boolean): {
  hasColumn: jest.Mock;
  query: jest.Mock;
} {
  return {
    hasColumn: jest.fn().mockResolvedValue(hasLegacyColumn),
    query: jest.fn().mockResolvedValue([]),
  };
}

describe('RemoveLegacyLessonDurationMinutes1970000000000', () => {
  it('backfills the seconds field before removing the obsolete NOT NULL column', async () => {
    const q = runner(true);

    await new RemoveLegacyLessonDurationMinutes1970000000000().up(q as unknown as QueryRunner);

    expect(q.hasColumn).toHaveBeenCalledWith('lessons', 'duration_minutes');
    expect(q.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('SET "duration" = "duration_minutes" * 60'),
    );
    expect(q.query).toHaveBeenNthCalledWith(
      2,
      'ALTER TABLE "lessons" DROP COLUMN "duration_minutes"',
    );
  });

  it('is safe when the legacy column has already been removed', async () => {
    const q = runner(false);

    await new RemoveLegacyLessonDurationMinutes1970000000000().up(q as unknown as QueryRunner);

    expect(q.query).not.toHaveBeenCalled();
  });

  it('restores a nullable compatibility column only when rolling back', async () => {
    const q = runner(false);

    await new RemoveLegacyLessonDurationMinutes1970000000000().down(q as unknown as QueryRunner);

    expect(q.query).toHaveBeenNthCalledWith(
      1,
      'ALTER TABLE "lessons" ADD COLUMN "duration_minutes" integer',
    );
    expect(q.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SET "duration_minutes" = FLOOR("duration" / 60.0)::integer'),
    );
  });
});
