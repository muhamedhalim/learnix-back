import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCertificateCourseTemplatesAndHistory2066000000000 implements MigrationInterface {
  name = 'AddCertificateCourseTemplatesAndHistory2066000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "lesson_packages"
      ADD COLUMN "certificate_template_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "lesson_packages"
      ADD CONSTRAINT "FK_lesson_packages_certificate_template"
      FOREIGN KEY ("certificate_template_id") REFERENCES "certificate_templates"("id")
      ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_lesson_packages_certificate_template_id"
      ON "lesson_packages" ("certificate_template_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "certificate_history" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "certificate_id" uuid NOT NULL,
        "certificate_number" varchar(40) NOT NULL,
        "verification_code" varchar(40) NOT NULL,
        "status" "certificate_status_enum" NOT NULL,
        "revoked_at" timestamptz,
        "revoke_reason" text,
        "reissued_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_certificate_history" PRIMARY KEY ("id"),
        CONSTRAINT "FK_certificate_history_certificate"
          FOREIGN KEY ("certificate_id") REFERENCES "certificates"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_certificate_history_certificate_created"
      ON "certificate_history" ("certificate_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_certificate_history_verification_code"
      ON "certificate_history" ("verification_code")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_certificate_history_verification_code"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_certificate_history_certificate_created"`);
    await queryRunner.query(`DROP TABLE "certificate_history"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_lesson_packages_certificate_template_id"`);
    await queryRunner.query(`ALTER TABLE "lesson_packages" DROP CONSTRAINT "FK_lesson_packages_certificate_template"`);
    await queryRunner.query(`ALTER TABLE "lesson_packages" DROP COLUMN "certificate_template_id"`);
  }
}
