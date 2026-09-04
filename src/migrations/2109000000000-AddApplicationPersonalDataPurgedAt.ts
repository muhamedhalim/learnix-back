import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T222 (FR-315). The retention job's idempotency marker: once a decided
 * application's personal content has been purged (24 months after
 * `reviewed_at`), this timestamp records it happened, so a later run of the
 * same sweep does not re-select an already-purged row forever. Nullable —
 * absent means "not purged yet", which is every row today.
 */
export class AddApplicationPersonalDataPurgedAt2109000000000 implements MigrationInterface {
  public name = 'AddApplicationPersonalDataPurgedAt2109000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "marketplace_instructor_applications"
        ADD COLUMN IF NOT EXISTS "personal_data_purged_at" timestamptz NULL;
      CREATE INDEX IF NOT EXISTS "IDX_mp_applications_retention_sweep"
        ON "marketplace_instructor_applications" ("reviewed_at")
        WHERE "reviewed_at" IS NOT NULL AND "personal_data_purged_at" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_mp_applications_retention_sweep";
      ALTER TABLE "marketplace_instructor_applications"
        DROP COLUMN IF EXISTS "personal_data_purged_at";
    `);
  }
}
