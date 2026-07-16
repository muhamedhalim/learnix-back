import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds the bounded visual-builder configuration and template ownership. */
export class AddCertificateBuilderTemplateFields1860000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "certificate_templates"
        ADD COLUMN IF NOT EXISTS "owner_id" UUID,
        ADD COLUMN IF NOT EXISTS "layout" VARCHAR(24) NOT NULL DEFAULT 'classic',
        ADD COLUMN IF NOT EXISTS "font" VARCHAR(24) NOT NULL DEFAULT 'sans',
        ADD COLUMN IF NOT EXISTS "title_font_size" SMALLINT NOT NULL DEFAULT 34,
        ADD COLUMN IF NOT EXISTS "body_font_size" SMALLINT NOT NULL DEFAULT 16,
        ADD COLUMN IF NOT EXISTS "text_alignment" VARCHAR(12) NOT NULL DEFAULT 'center'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_certificate_templates_owner_id"
      ON "certificate_templates" ("owner_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_certificate_templates_owner_id"`);
    await queryRunner.query(`
      ALTER TABLE "certificate_templates"
        DROP COLUMN IF EXISTS "text_alignment",
        DROP COLUMN IF EXISTS "body_font_size",
        DROP COLUMN IF EXISTS "title_font_size",
        DROP COLUMN IF EXISTS "font",
        DROP COLUMN IF EXISTS "layout",
        DROP COLUMN IF EXISTS "owner_id"
    `);
  }
}
