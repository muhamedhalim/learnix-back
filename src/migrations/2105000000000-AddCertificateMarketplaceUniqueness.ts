import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FR-248: "exactly one certificate per completed enrollment." The academic
 * half of that guarantee already exists (`UQ_certificate_student_package`),
 * but `2100000000000-ExtendCertificatesForMarketplace` added
 * `marketplace_course_id` with no equivalent — a unique constraint on
 * `(student_id, package_id)` never fires for two marketplace rows, since
 * `package_id` is NULL on both (Postgres does not treat NULLs as equal for
 * uniqueness purposes). A partial unique index, scoped to only the rows
 * that actually carry a marketplace course, closes the gap the same way
 * `UQ_mp_orders_open_per_course` and similar partial indexes already do
 * elsewhere in this feature.
 */
export class AddCertificateMarketplaceUniqueness2105000000000 implements MigrationInterface {
  public name = 'AddCertificateMarketplaceUniqueness2105000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_certificates_student_marketplace_course"
        ON "certificates" ("student_id", "marketplace_course_id")
        WHERE "marketplace_course_id" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_certificates_student_marketplace_course";
    `);
  }
}
