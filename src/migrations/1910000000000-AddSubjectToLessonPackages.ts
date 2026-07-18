import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `lesson_packages.subject_id`, restoring a link that the initial
 * schema (`1734986400000-InitialSchema.ts`) declared as `NOT NULL` but that
 * was never actually created on databases where `lesson_packages` already
 * existed from an earlier `synchronize: true` run — `CREATE TABLE IF NOT
 * EXISTS` is a no-op once the table exists, so the column silently never
 * materialized. The application layer (entity/DTO/service) also never
 * mapped it, so `POST /teacher/packages` started failing with a
 * not-null-constraint error the moment `subject_id` was re-added there
 * without a matching DB column.
 *
 * Nullable, not NOT NULL: existing packages have no subject on record and
 * there is no sensible default to backfill with, so forcing NOT NULL here
 * would either fail outright or require guessing data. `subject_id` stays
 * strictly required at the API layer for every new/updated package
 * (`CreatePackageDto`/`UpdatePackageDto`) — this migration only has to not
 * break packages that already exist.
 */
export class AddSubjectToLessonPackages1910000000000 implements MigrationInterface {
  name = 'AddSubjectToLessonPackages1910000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "lesson_packages"
      ADD COLUMN IF NOT EXISTS "subject_id" uuid
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "lesson_packages"
        ADD CONSTRAINT "FK_lesson_packages_subject"
        FOREIGN KEY ("subject_id") REFERENCES "subjects"("id");
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lesson_packages_subject_id"
      ON "lesson_packages" ("subject_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_lesson_packages_subject_id"`);
    await queryRunner.query(`
      ALTER TABLE "lesson_packages" DROP CONSTRAINT IF EXISTS "FK_lesson_packages_subject"
    `);
    await queryRunner.query(`
      ALTER TABLE "lesson_packages" DROP COLUMN IF EXISTS "subject_id"
    `);
  }
}
