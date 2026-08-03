import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCertificateAutoIssuanceRetry2068000000000 implements MigrationInterface {
  name = 'AddCertificateAutoIssuanceRetry2068000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "certificate_auto_issuance_failures" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "student_id" uuid NOT NULL,
        "lesson_id" uuid NOT NULL,
        "package_id" uuid NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" text NOT NULL,
        "next_retry_at" timestamptz NOT NULL,
        "resolved_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_certificate_auto_issuance_failures" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_certificate_auto_issuance_failure_course" UNIQUE ("student_id", "lesson_id", "package_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_certificate_auto_issuance_failures_retry"
      ON "certificate_auto_issuance_failures" ("resolved_at", "next_retry_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_certificate_auto_issuance_failures_retry"`);
    await queryRunner.query(`DROP TABLE "certificate_auto_issuance_failures"`);
  }
}
