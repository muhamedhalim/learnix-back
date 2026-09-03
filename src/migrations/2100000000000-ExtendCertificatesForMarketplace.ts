import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Eighth marketplace migration (plan.md §3 migration 8 of 8) — **the only
 * academic table this feature touches**, permitted by the FR-322 isolation
 * carve-out because every change here is additive: no existing row's value
 * or meaning changes, and no academic query gains a dependency on the
 * marketplace. See T205 for the academic regression suite this migration
 * must leave passing unchanged, and T228 for the bidirectional isolation
 * test (FR-323).
 *
 * `up()` backfills `source = 'academic'` for every pre-existing row before
 * `CHK_certificates_one_subject` is added, so the constraint holds for the
 * whole table the instant it is created.
 */
export class ExtendCertificatesForMarketplace2100000000000 implements MigrationInterface {
  public name = 'ExtendCertificatesForMarketplace2100000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "certificates" ALTER COLUMN "package_id" DROP NOT NULL;
      ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "marketplace_course_id" uuid;
      ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "source" character varying(20);
    `);
    await queryRunner.query(`
      UPDATE "certificates" SET "source" = 'academic' WHERE "source" IS NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "certificates" ALTER COLUMN "source" SET DEFAULT 'academic';
      ALTER TABLE "certificates" ALTER COLUMN "source" SET NOT NULL;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_certificates_marketplace_course'
        ) THEN
          ALTER TABLE "certificates" ADD CONSTRAINT "FK_certificates_marketplace_course"
            FOREIGN KEY ("marketplace_course_id") REFERENCES "marketplace_courses" ("id")
            ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'CHK_certificates_one_subject'
        ) THEN
          ALTER TABLE "certificates" ADD CONSTRAINT "CHK_certificates_one_subject" CHECK (
            ("package_id" IS NOT NULL AND "marketplace_course_id" IS NULL)
            OR ("package_id" IS NULL AND "marketplace_course_id" IS NOT NULL)
          );
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_certificates_marketplace_course_id"
        ON "certificates" ("marketplace_course_id");
      CREATE INDEX IF NOT EXISTS "IDX_certificates_source"
        ON "certificates" ("source");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_certificates_source";
      DROP INDEX IF EXISTS "IDX_certificates_marketplace_course_id";
      ALTER TABLE "certificates" DROP CONSTRAINT IF EXISTS "CHK_certificates_one_subject";
      ALTER TABLE "certificates" DROP CONSTRAINT IF EXISTS "FK_certificates_marketplace_course";
      ALTER TABLE "certificates" DROP COLUMN IF EXISTS "source";
      ALTER TABLE "certificates" DROP COLUMN IF EXISTS "marketplace_course_id";
      ALTER TABLE "certificates" ALTER COLUMN "package_id" SET NOT NULL;
    `);
  }
}
