import type { QueryRunner } from 'typeorm';

import { SecureExamAudiences1880000000000 } from '../../migrations/1880000000000-SecureExamAudiences';
import { AddExamCourseAudience1890000000000 } from '../../migrations/1890000000000-AddExamCourseAudience';

function runner(responses: unknown[] = []): { queryRunner: QueryRunner; query: jest.Mock } {
  let responseIndex = 0;
  const query = jest.fn(async () => responses[responseIndex++] ?? []);
  return { queryRunner: { query } as unknown as QueryRunner, query };
}

describe('exam audience migrations', () => {
  it('adds public flags idempotently with listing indexes', async () => {
    const { queryRunner, query } = runner();

    await new SecureExamAudiences1880000000000().up(queryRunner);

    const sql = query.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "is_public"');
    expect(sql).toContain('ALTER COLUMN "is_public" SET NOT NULL');
    expect(sql).toContain('IDX_exams_public_status_created');
    expect(sql).toContain('WHERE "deleted_at" IS NULL AND "is_public" = true');
  });

  it('adds restrictive audience foreign keys and a database shape constraint', async () => {
    const { queryRunner, query } = runner();

    await new AddExamCourseAudience1890000000000().up(queryRunner);

    const sql = query.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(sql).toContain('FK_exams_package_id');
    expect(sql).toContain('FK_exams_lesson_id');
    expect(sql).toContain('ON DELETE RESTRICT NOT VALID');
    expect(sql).toContain('CK_exams_audience_shape');
    expect(sql).toContain('VALIDATE CONSTRAINT');
  });

  it('refuses destructive rollbacks after audience data exists', async () => {
    const publicRunner = runner([[{ public_exams: '1', public_questions: '0' }]]);
    await expect(
      new SecureExamAudiences1880000000000().down(publicRunner.queryRunner),
    ).rejects.toThrow('Refusing to drop public audience columns');

    const courseRunner = runner([[{ count: '1' }]]);
    await expect(
      new AddExamCourseAudience1890000000000().down(courseRunner.queryRunner),
    ).rejects.toThrow('Refusing to drop package_id');
  });
});
