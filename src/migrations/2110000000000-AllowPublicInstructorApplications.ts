import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a person apply to teach on the marketplace without first registering
 * into the academic student or teacher lifecycle.
 *
 * Two widenings, both additive and safe on existing data:
 *
 * 1. `users.role` becomes nullable, so an approved instructor can hold a
 *    platform identity with *no* academic role. Existing rows all keep their
 *    role, and the `student` default is retained so any insert that omits the
 *    column behaves exactly as before. Academic role checks compare against
 *    this column, and SQL comparisons never match NULL, so such an account is
 *    excluded from every academic list, report and guard by construction.
 *    Instructor authority is not stored here — it stays in
 *    `marketplace_instructors`.
 *
 * 2. `marketplace_instructor_applications.user_id` becomes nullable and the
 *    table gains applicant contact details, so a public application can exist
 *    before its account does. The account is provisioned at approval, which is
 *    when `user_id` is filled in.
 *
 * Postgres treats NULLs as distinct in unique indexes, so the existing
 * `UQ_mp_applications_user_open` keeps constraining signed-in applicants
 * unchanged; anonymous rows are deduplicated by email instead.
 */
export class AllowPublicInstructorApplications2110000000000 implements MigrationInterface {
  public name = 'AllowPublicInstructorApplications2110000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "role" DROP NOT NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE "marketplace_instructor_applications"
        ALTER COLUMN "user_id" DROP NOT NULL;
      ALTER TABLE "marketplace_instructor_applications"
        ADD COLUMN IF NOT EXISTS "applicant_email" varchar(255) NULL,
        ADD COLUMN IF NOT EXISTS "applicant_phone" varchar(30) NULL;
    `);

    // Every application must identify its applicant: an existing account, or
    // contact details good enough to provision one at approval.
    await queryRunner.query(`
      ALTER TABLE "marketplace_instructor_applications"
        DROP CONSTRAINT IF EXISTS "CHK_mp_applications_applicant_identity";
      ALTER TABLE "marketplace_instructor_applications"
        ADD CONSTRAINT "CHK_mp_applications_applicant_identity"
        CHECK ("user_id" IS NOT NULL OR "applicant_email" IS NOT NULL);
    `);

    // FR-015's "one open application per applicant", for applicants who have
    // no account yet and so cannot be constrained by `user_id`.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_mp_applications_applicant_email_open"
        ON "marketplace_instructor_applications" ("applicant_email")
        WHERE "user_id" IS NULL
          AND "status" IN ('draft','submitted','under_review','approved');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_mp_applications_applicant_email_open";
      ALTER TABLE "marketplace_instructor_applications"
        DROP CONSTRAINT IF EXISTS "CHK_mp_applications_applicant_identity";
    `);

    // An application with no account cannot satisfy a NOT NULL `user_id`, and
    // inventing one would be worse than refusing: these rows only exist
    // because the feature this migration enables was in use.
    await queryRunner.query(`
      DELETE FROM "marketplace_instructor_applications" WHERE "user_id" IS NULL;
      ALTER TABLE "marketplace_instructor_applications"
        DROP COLUMN IF EXISTS "applicant_email",
        DROP COLUMN IF EXISTS "applicant_phone";
      ALTER TABLE "marketplace_instructor_applications"
        ALTER COLUMN "user_id" SET NOT NULL;
    `);

    // Lossy by necessity: the old schema had no way to express "no academic
    // role", so marketplace-only identities collapse to the column's own
    // historical default rather than blocking the rollback.
    await queryRunner.query(`
      UPDATE "users" SET "role" = 'student' WHERE "role" IS NULL;
      ALTER TABLE "users" ALTER COLUMN "role" SET NOT NULL;
    `);
  }
}
