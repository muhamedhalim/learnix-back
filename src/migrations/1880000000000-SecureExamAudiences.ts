import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds explicit public/private classification used by exam and practice policies. */
export class SecureExamAudiences1880000000000 implements MigrationInterface {
  public readonly name = 'SecureExamAudiences1880000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS is intentional: some long-lived environments were shaped
    // by synchronize before migration execution was repaired. Preserve any
    // classifications already present while bringing history back in sync.
    await queryRunner.query(`ALTER TABLE "exams" ADD COLUMN IF NOT EXISTS "is_public" boolean`);
    await queryRunner.query(`UPDATE "exams" SET "is_public" = false WHERE "is_public" IS NULL`);
    await queryRunner.query(`ALTER TABLE "exams" ALTER COLUMN "is_public" SET DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "exams" ALTER COLUMN "is_public" SET NOT NULL`);

    await queryRunner.query(`ALTER TABLE "questions" ADD COLUMN IF NOT EXISTS "is_public" boolean`);
    await queryRunner.query(`UPDATE "questions" SET "is_public" = false WHERE "is_public" IS NULL`);
    await queryRunner.query(`ALTER TABLE "questions" ALTER COLUMN "is_public" SET DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "questions" ALTER COLUMN "is_public" SET NOT NULL`);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_exams_is_public" ON "exams" ("is_public")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_questions_is_public" ON "questions" ("is_public")`,
    );
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_exams_public_status_created"
      ON "exams" ("status", "created_at" DESC, "id")
      WHERE "deleted_at" IS NULL AND "is_public" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Never silently erase classifications created after rollout. A rollback
    // with public content must be a forward-compatible application rollback.
    const classified = (await queryRunner.query(`
      SELECT
        (SELECT COUNT(*) FROM "exams" WHERE "is_public" = true)::text AS public_exams,
        (SELECT COUNT(*) FROM "questions" WHERE "is_public" = true)::text AS public_questions
    `)) as { public_exams: string; public_questions: string }[];
    if (
      Number(classified[0]?.public_exams ?? 0) > 0 ||
      Number(classified[0]?.public_questions ?? 0) > 0
    ) {
      throw new Error(
        'Refusing to drop public audience columns while classified exams or questions exist',
      );
    }

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_exams_public_status_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_questions_is_public"`);
    await queryRunner.query(`ALTER TABLE "questions" DROP COLUMN IF EXISTS "is_public"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_exams_is_public"`);
    await queryRunner.query(`ALTER TABLE "exams" DROP COLUMN IF EXISTS "is_public"`);
  }
}
